// datafiles - keep track of data files and whether they've been uploaded or downloaded
// also delete uploaded/downlaoded files if disk space is running very low
// Copyright ©2021 Thorsten von Eicken

// The DataSaver singleton creates files on one of the mounted media, specifically,
// on the first one that has space. This singleton "runs behind" and keeps track of what
// happens to the files over time using a simple JSON file that records uploads (to a server
// via the internet) and downloads (to a laptop/phone via the web UI).
//
// It also keeps some stats about each of the files so that the UI can display them.

// Duplicate files: in general the system does not produce duplicate files, but accidents
// can happen. The DataFiles code does not try to guard against duplicates, they will simply
// be there twice. To be re-evaluated...

// Data:
// The data is saved in a file (typ. /etc/sensorgnome/datafiles.json) and has the following structure:
// { ts: Date.now() when written
//   files: [
//     { dir: "/media/SD_card/SGdata/2021-12-01", // dir holding the file
//       date: "YYYYMMDD",
//       name: "file1.txt.gz",
//       type: "ctt", // data type (e.g. all/ctt/blu)
//       size: 12345, // file size in bytes
//       start: 1637958427, // unix timestamp when file was started, derived from filename
//       uploaded: 1637958429, // unix timestamp of last upload to server, null otherwise
//       downloaded: 1637958429, // unix timestamp of last download via web interface, null otherwise
//     }]}
// The data file is written when something changes, e.g., an new file is started, an
// upload is performed, etc
// Note: the original version of this module parsed data files to collect stats about the number
// of detections, this was removed 12/2024

const SAVE_DLY = 900 // milliseconds to delay save in case some more stuff shows up

// max number of lines combined into one file when repacking (see DataFiles.repack()). Chosen as
// a middle ground: hourly files typically carry a few hundred to a couple thousand lines, so this
// still merges many days worth of files together, while capping the size of any single merged
// file so it stays cheap to parse/retry server-side even for a receiver with heavy tag traffic
// (where 100k lines can be reached in well under a day).
const MAX_REPACK_LINES = 100_000

const Fs = require("fs")
const FSP = require("fs/promises")
const Zlib = require("zlib")
const util = require('node:util')
const execFile = util.promisify(require('node:child_process').execFile)

async function sleep(time) { return new Promise(resolve => setTimeout(resolve, time)) }

// find all files in a subtree and yield each file's {path, stat} in turn
// findFiles is an async generator (yay! ugh#%^), it will yield each {path,stat} value when 
// it's produced...
async function* findFiles(dir) {
    try {
        for (const file of await FSP.readdir(dir)) {
            const path = dir + "/" + file
            const stat = await FSP.stat(path)
            if (stat.isDirectory()) {
                yield* findFiles(path)
            } else {
                yield { path, stat }
            }
        }
    } catch (e) {
        console.log(`DataFiles failed to scan ${dir}: ${e}`)
    }
}

// regexp to match changeMe-7F5ERPI46977-1-2021-12-11T14-46-38.8260Z-all.txt.gz
var datafileRE = /^(.*)\/([^-]*-[^-]*-[0-9]+-([-0-9]+)(T[-0-9.]+)[P-Z]-([a-z]+).txt(.gz)?)$/ // phew!

class FileInfo {
    constructor(path) {
        const info = this.parseFilename(path)
        if (!info) throw Error("Invalid path")
        this.info = { ...info,
            size: 0,
            gps: false,
            uploaded: null,
            downloaded: null,
        }
        this.lines = ""
    }

    // return the file info
    toInfo() { return this.info }

    // parse a filename (path really) into the info it encodes
    // ex: /data/2021-11-26/csgs-7F5ERPI46977-000001-2021-11-26T20-26-38.4030V-ctt.txt
    parseFilename(path) {
        let mm = datafileRE.exec(path)
        if (!mm) return null
        const data = {
            dir: mm[1],
            date: mm[4].replace(/-/g, ""),
            start: Math.trunc( (new Date(mm[4] + mm[5].replace(/-/g, ":") + "Z")).getTime()/1000 ),
            name: mm[2],
            type: mm[6],
            bootCount: mm[3],
        }
        if (!data.date || !data.start) console.log("OOPS:", data)
        return data
    }

    // changes the path to the one provided and stats it to get the size
    // used in safestream after the file is gzipped
    async statFile(path) {
        this.info = { ...this.info, ...this.parseFilename(path) }
        this.info.size = (await FSP.stat(path)).size
    }

    setSize(sz) { this.info.size = sz }
}

class DataFiles {

    constructor(matron, datadir, datafiles) {
        this.matron = matron
        this.datadir = datadir
        this.datafile_path = datafiles
        this.files = [] // to be populated from file plus discovery
        this.reading = true // we're reading the data file, so don't overwrite it yet
        this.saving = false // lock to avoid concurrent saves
        this.save_timer = null // timer to delay save

        matron.on("datafile", (info) => this.addFile(info, /*save=*/true))
        
        // summary information used by the dashboard
        this.summary = {
            total_files: 0, total_bytes: 0, pre_2010_files: 0, other_sg_files: 0,
        }
    }

    // start tracking data files, begins by reading the file with info from previous runs, then
    // performs a scan of mounted media to see what we can find
    async start() {
        // read the datafile
        try {
            let info = JSON.parse(await FSP.readFile(this.datafile_path))
            if (info.files) {
                info.files.forEach(i => this.addStats(i, false))
                this.files = this.files.concat(info.files)
                let iso = new Date(info.ts).toISOString()
                console.log(`DataFiles: read ${this.files.length} records written ${iso}`)
            }
        } catch(e) {
            console.log(`DataFiles: cannot read ${this.datafile_path}: ${e}\n...starting afresh`)
        }
        // update the info we have and kick-off daily compression of files
        this.daily().then(()=>{})
    }

    // check the filesystem for unexpected changes as well as compress files about once a day
    async daily() {
        this.reading = true
        await this.updateTree(this.datadir)
        this.reading = false
        await this.save()
        this.reading = true
        await this.compressFiles(this.datadir)
        this.reading = false
        await this.save()
        this.updateStats()
        this.pubStats()

        setTimeout(() => this.daily().then(()=>{}), 23*3600*1000)
    }

    // save the accumulated info about data files to a json file
    async save() {
        // at start-up we may be asked to save before we're done reading the old json info so
        // prevent that from happening here.
        while (this.reading || this.saving) await new Promise(res => setTimeout(res, 1000))
        this.saving = true // lock
        try {
            let info = { ts: Date.now(), files: this.files }
            await FSP.writeFile(this.datafile_path + "~", JSON.stringify(info))
            await FSP.rename(this.datafile_path + "~", this.datafile_path)
            console.log(`DataFiles: saved ${this.files.length} records`)
        } catch(e) {
            console.log(`DataFiles: cannot save ${this.datafile_path}: ${e}`)
        }
        this.saving = false
    }

    saveSoon() {
        if (!this.save_timer) {
            this.save_timer = setTimeout(() => {
                this.save().then(()=>{})
                this.save_timer = null
            }, SAVE_DLY)
        }
    }

    // update information about data files starting at the given dir
    async updateTree(dir) {
        for (const f of this.files) f.found = false
        for await (const { path, stat } of findFiles(dir)) {
            if (OpenFiles.includes(path)) continue // don't add files that are open (in SafeStream)
            if (stat.size === 0) {
                // stray empty file (e.g. left over from a crash, or a gzip that failed when the
                // SD card was full) -- nothing to upload/download, so reclaim the space instead of
                // tracking it forever
                console.log(`Datafile ${path} is empty, removing`)
                try { await FSP.unlink(path) } catch (e) { console.log(`Failed to remove empty file ${path}: ${e}`) }
                continue
            }
            let file_info
            try {
                file_info = new FileInfo(path)
            } catch(e) {
                console.log(`Warning: ${e} for ${path}`)
                continue
            }
            // check whether we have this file already, and if not scan it and add it
            const name = file_info.toInfo().name
            const f = this.files.find(f => f.name == name)
            if (f) {
                f.found = true
            } else {
                if (stat.size !== null) file_info.setSize(stat.size)
                file_info.info.found = true
                this.addFile(file_info.toInfo(), false)
            }
        }
        // any files missing?
        for (let i=0; i<this.files.length; ) {
            const f = this.files[i]
            if (f.found) {
                i++
            } else {
                console.log(`Datafile ${f.name} has disappeared`)
                this.delStats(f)
                this.files.splice(i, 1)
            }
            delete f.found
        }
    }

    // find files in the DB that are uncompressed and either have been uplaoded or are old and
    // compress them (slowly). Very recent files are not compressed so they can be uploaded
    async compressFiles(dir) {
        const cutoff = Date.now()/1000 - 48*3600 // don't compress files more recent than 48 hours
        console.log(`Compressing files, cutoff=${cutoff}`)
        for (const file of this.files) {
            const path = file.dir + '/' + file.name
            if (path.endsWith('.gz')) continue
            if (!path.endsWith('.txt')) continue // redundant, for safety...
            if (!file.uploaded && file.start > cutoff) continue
            console.log(`Bg gzip ${file.name}`)
            try {
                const {stdout, stderr} = await execFile("/usr/bin/nice", ["/usr/bin/gzip", path])
                const gzpath = path + '.gz'
                const oldsize = file.size
                this.delStats(file)
                file.size = (await FSP.stat(gzpath)).size
                file.name = gzpath
                this.addStats(file, false)
            } catch (err) {
                console.log(`Failed to compress ${path}: ${err}`)
                //if (err.stderr) console.log(err.stderr)
            }
            await sleep(10*1000)
        }
    }
    
    // add info about a data file and save all the info (the initial filesystem scan uses
    // save=false so only one save occurs at the end)
    addFile(info, save=true) {
        this.files.push(info)
        if (typeof __TEST__ === 'undefined')
            console.log(`DataFile ${info.name} added`)
        this.addStats(info, save && !this.reading) // don't pub while reading
        // save if desired
        if (save) this.saveSoon() // delay and make async
    }
    
    // add stats that only depend on files and not on upload/download activity
    addStats(info, pub=true) {
        // update summary stats
        this.summary.total_files++
        this.summary.total_bytes += info.size
        if (!info.uploaded) {
            this.summary.files_to_upload++
            this.summary.bytes_to_upload += info.size
        }
        if (!info.uploaded && !info.downloaded) {
            this.summary.files_to_download++
            this.summary.bytes_to_download += info.size
        }
        if (info.date < '20100101') this.summary.pre_2010_files++
        const id = Machine.machineID.substring(Machine.machineID.indexOf('-')+1)
        if (!info.name?.includes(id)) this.summary.other_sg_files++
        if (pub) this.pubStats()
    }

    // remove stats due to a file gone missing
    delStats(info) {
        this.summary.total_files--
        this.summary.total_bytes -= info.size
        if (!info.uploaded) {
            this.summary.files_to_upload--
            this.summary.bytes_to_upload -= info.size
        }
        if (!info.uploaded && !info.downloaded) {
            this.summary.files_to_download--
            this.summary.bytes_to_download -= info.size
        }
        if (info.date < '20100101') this.summary.pre_2010_files--
        const id = Machine.machineID.substring(Machine.machineID.indexOf('-')+1)
        if (!info.name?.includes(id)) this.summary.other_sg_files--
    }

    // update stats that can change due to an upload or download
    updateStats() {
        // tally files to upload/download
        this.summary = {
            ...this.summary,
            files_to_upload: 0, files_to_download: 0, bytes_to_upload: 0, bytes_to_download: 0
        }
        this.files.forEach(f => {
            if (!f.uploaded) {
                this.summary.files_to_upload++
                this.summary.bytes_to_upload += f.size
            }
            if (!f.uploaded && !f.downloaded) {
                this.summary.files_to_download++
                this.summary.bytes_to_download += f.size
            }
        })
        // determine last upload/download dates
        let last_download = this.files.reduce(
            (ld, f) => f.downloaded && f.downloaded > ld ? f.downloaded : ld, null)
        this.summary.last_download = last_download
        let last_upload = this.files.reduce(
            (lu, f) => f.uploaded && f.uploaded.date > lu ? f.uploaded.date : lu, null)
        this.summary.last_upload = last_upload
        // last of either for 1st tab
        this.summary.last_updownload = last_upload > last_download ? last_upload : last_download
    }

    pubStats() {
        console.log("DataFile stats:", JSON.stringify(this.summary))
        this.matron.emit("data_file_summary", this.summary)
    }

    // group key used by repack(): files are only ever combined with others of the same
    // type and bootCount, so a merged file never mixes data types or spans a reboot
    repackGroupKey(f) { return `${f.type}|${f.bootCount}` }

    // read a data file, transparently decompressing if it's gzipped
    async readMaybeGz(path) {
        const raw = await FSP.readFile(path)
        return path.endsWith('.gz') ? Zlib.gunzipSync(raw) : raw
    }

    // count text lines in a buffer (counts a final line even without a trailing newline)
    countLines(data) {
        if (data.length === 0) return 0
        let n = 0
        for (let i = 0; i < data.length; i++) if (data[i] === 10) n++
        if (data[data.length - 1] !== 10) n++
        return n
    }

    // Repack a maximal contiguous run of same-group files (already in chronological order) into
    // as few merged files as possible, capping each merged file at MAX_REPACK_LINES lines. A
    // source file's lines are never split across two merged outputs, so a chunk can end up
    // somewhat over the cap if a single source file is already large.
    async mergeRun(run) {
        let chunk = [] // [{ f, data }] accumulated for the current output file
        let lineCount = 0
        const flush = async () => {
            if (chunk.length > 1) await this.writeMergedFile(chunk)
            chunk = []
            lineCount = 0
        }
        for (const f of run) {
            let data = await this.readMaybeGz(f.dir + '/' + f.name)
            // guard against a missing trailing newline joining two files' lines together
            if (data.length && data[data.length - 1] !== 10) data = Buffer.concat([data, Buffer.from('\n')])
            chunk.push({ f, data })
            lineCount += this.countLines(data)
            if (lineCount >= MAX_REPACK_LINES) await flush()
        }
        await flush()
    }

    // merge the files in chunk (in order) into a single gzip-compressed file, named after the
    // first (earliest) source file -- since that's the name a downstream consumer would expect
    // for the start of this time range. Writes to a temp file first so a crash mid-merge can't
    // leave a truncated file in place of the originals.
    async writeMergedFile(chunk) {
        const first = chunk[0].f
        const outName = first.name.endsWith('.gz') ? first.name : first.name + '.gz'
        const outPath = first.dir + '/' + outName
        const tmpPath = outPath + '~'
        const gzip = Zlib.createGzip()
        const outStream = Fs.createWriteStream(tmpPath)
        const done = new Promise((resolve, reject) => {
            outStream.on('finish', resolve)
            outStream.on('error', reject)
            gzip.on('error', reject)
        })
        gzip.pipe(outStream)
        for (const { data } of chunk) gzip.write(data)
        gzip.end()
        await done

        const finalSize = (await FSP.stat(tmpPath)).size
        for (const { f } of chunk) {
            const path = f.dir + '/' + f.name
            if (path !== outPath) {
                try { await FSP.unlink(path) } catch (e) { console.log(`Repack: failed to remove ${path}: ${e}`) }
            }
        }
        await FSP.rename(tmpPath, outPath)

        const removed = chunk.map(c => c.f)
        for (const f of removed) this.delStats(f)
        this.files = this.files.filter(f => !removed.includes(f))
        const merged = {
            dir: first.dir, date: first.date, start: first.start, name: outName,
            type: first.type, bootCount: first.bootCount, size: finalSize,
            uploaded: null, downloaded: null,
        }
        this.files.push(merged)
        this.addStats(merged, false)
        console.log(`Repack: merged ${chunk.length} files into ${outName} (${finalSize} bytes)`)
    }

    // Combine files of the same type+bootCount into fewer, larger files so there's less to parse
    // through server-side after an archive is downloaded/uploaded and unpacked. Only files that
    // are neither uploaded nor downloaded are touched -- this keeps the operation safe to run
    // repeatedly and never disturbs the record of what's already been sent/fetched (in
    // particular, downloadList('last') keeps returning exactly what was last downloaded). Within
    // that candidate set, only *contiguous* runs (per the full on-disk chronological order for
    // that type+bootCount) are merged: a non-candidate file (already uploaded/downloaded) breaks
    // the run, since files on either side of it must not be combined across that gap.
    async repack() {
        const byGroup = new Map()
        for (const f of this.files) {
            const k = this.repackGroupKey(f)
            if (!byGroup.has(k)) byGroup.set(k, [])
            byGroup.get(k).push(f)
        }
        for (const group of byGroup.values()) {
            group.sort((a, b) => a.start - b.start)
            let run = []
            for (const f of group) {
                if (!f.downloaded && !f.uploaded) {
                    run.push(f)
                } else {
                    if (run.length > 1) await this.mergeRun(run)
                    run = []
                }
            }
            if (run.length > 1) await this.mergeRun(run)
        }
        this.pubStats()
        this.saveSoon()
    }

    // repack files before a manual download so the archive contains fewer, larger text files.
    // `what` (new/all/last) is accepted for symmetry with downloadList() but doesn't change what
    // gets repacked: repack() already restricts itself to not-yet-uploaded/downloaded files,
    // which is exactly the set that "new"/"all" downloads care about, and there's nothing to
    // repack for "last" (those files were necessarily already downloaded before this could run).
    async repackForDownload(what) {
        await this.repack()
    }

    downloadList(what) {
        switch(what) {
            case "new":
                return this.files.filter(f => !f.downloaded && !f.uploaded)
                                 .map(f => f.dir + '/' + f.name)
            case "all":
                return this.files.map(f => f.dir + '/' + f.name)
            case "last":
                return this.files.filter(f => f.downloaded == this.summary.last_download)
                                 .map(f => f.dir + '/' + f.name)
            default: return []
        }
    }

    // uploadList returns a set of files that are candidates for uploading
    // It returns an array of files, each one being [fname, size, file_start_timestamp]
    // It first groups files by date+bootCount, then picks a group at random, and then returns
    // all the files in that group.
    // This is done for a couple of reasons, but may not be 'optimal': the random selection
    // avoids always retrying the same upload that may cause some fatal failure, the grouping by
    // date allows the archive SHA1 deduplication to do something if the data_files database
    // is lost. Grouping by bootCount too keeps files from different boots (e.g. a reboot mid-day)
    // out of the same archive. Empty files carry no data and are excluded.
    uploadList() {
        const uploadable = this.files.filter(f => !f.uploaded && f.size > 0)
        const groupOf = f => `${f.date}|${f.bootCount}`
        const groups = uploadable.map(groupOf).filter((v, i, a) => a.indexOf(v) === i)
        if (groups.length == 0) return []
        const group = groups[Math.floor(Math.random() * groups.length)]
        const files = uploadable.filter(f => groupOf(f) == group).map(f => [f.dir + '/' + f.name, f.size, f.start])
        const [date, bootCount] = group.split('|')
        console.log(`UploadList: ${files.length} files for ${date} boot ${bootCount}`)
        return {date, files}
    }
    
    // update the upload or download info of all the files listed
    updateUpDownDate(which, files, info) {
        // sanity check on dates (unix timestamps), too easy to mess up...
        if (which == "uploaded") {
            if (!info.date || !(info.date > 1514764800 && info.date < 2145934800)) { //2018..2038
                throw new Error(`Invalid upload date in info: ${info}`)
            }
        } else if (which == "downloaded") {
            if (!info || !(info > 1514764800 && info < 2145934800)) { //2018..2038
                throw new Error(`Invalid download date: ${info}`)
            }
        } else {
            throw new Error("must pass uploaded/downloaded")
        }
        if (files && typeof files[0] != 'string') throw new Error("file list must be strings")

        files.forEach(f => {
            const i = this.files.findIndex(x => x.dir + '/' + x.name == f)
            if (i >= 0) this.files[i][which] = info
            else console.log("updateUpDownDate: cannot mark file, not found", f)
        })
        this.saveSoon() // delay and make async
        this.updateStats()
        this.matron.emit("data_file_summary", this.summary)
    }

}

module.exports = { DataFiles, FileInfo, MAX_REPACK_LINES }
