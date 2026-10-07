/*
  safestream.js : safe writable stream on a disk, which writes in text. After an hour, or a
  specified number of bytes, or if there is a clock step it starts a new file and
  compresses the previous one to .txt.gz.

  In principle a SafeStream is agnostic to its contents/format, but we do want to keep track of
  some stats, like the number of data records written, at least for the data files, which is 100%
  of SafeStream's usage. So the `parse` flag to the constructor enables parsing of what gets
  written, assuming it's a line-record format. Ugly violation of abstraction levels but simple.

  Note: the original version wrote simultaneously to .txt and .txt.gz and deleted the .txt
  on closing. The purpose of the txt was for recovery if the process crashes or the system
  runs out of power (not uncommon on solar), but it ends up leaving a bunch of .txt files
  that complicate anything downstream that touches any files.
  Writing to txt and then running gzip to compress makes everything simpler, the only downside
  is that when the SDcard is full the gz may fail, so there would be an uncompressed txt file left.
  In the days of 32GB SDcards for $10 that should be a rare occurrence...

  Updated 2024: this module no longer compresses the files so they can easily be filtered
  before being uploaded. Instead, files are compressed later.
*/

const { FileInfo } = require("./datafiles")

OpenFiles = [] // file names of currently open files so DataFiles doesn't add them to its list

class SafeStream {
    constructor (matron, source, ext, chunkbytes, chunksecs, parse) {
        // source will usually be "all", and extension will usually be ".txt"

        this.matron = matron
        this.source = source
        this.ext = ext
        this.chunksecs = chunksecs
        this.chunkbytes = chunkbytes
        this.lastData = null
        this.parse = parse
        this.sout = null
        this.bytesWritten = 0
        this.chunkTimer = null
        // Note: the file is NOT opened here. It's opened lazily on the first write() so that
        // e.g. a PPM data file isn't created when no PPM dongle is attached to produce data for it.
        matron.on("gpsSetClock", () => this.gpsSetClock())
    }

    setupStreams () {
        let path = DataSaver.getRelPath(this.source)
        this.tscode = Chrony.timeStampCode() // time-stamp precision used by DataSaver (yuck)
        this.sout = DataSaver.getStream(path, this.ext)
        OpenFiles.push(this.sout.path)
        this.sout.stream.on("error", (e) => this.streamError(e))
        this.bytesWritten = 0
        this.info = this.parse && new FileInfo(this.sout.path)
        if (this.chunkTimer) clearTimeout(this.chunkTimer)
        // only fires while this.sout is open, so end() always has a real file to rotate
        this.chunkTimer = setTimeout(() => this.end(), this.chunksecs * 1000)
    }

    write (data) {
        if (!this.sout) this.setupStreams() // lazily open on first data since the last rotation
        this.lastData = data
        this.sout.stream.write(data)
        this.bytesWritten += data.length
        if (this.bytesWritten >= this.chunkbytes) this.end()
    }

    // by the time gzip gets called the SafeStream object may well already be re-initialized
    // for the next file, so we shouldn't use this.info
    // note: not used anymore! see end() method
    gzip(path, info, bw) {
        // the gzip process is a bit of a fire-and-forget: if it fails the uncompressed
        // file will still be there
        console.log(`SafeStream: gzipping ${path}`)
        ChildProcess.execFile("/usr/bin/gzip", [path], (err, stdout, stderr) => {
            OpenFiles = OpenFiles.filter(f => f != path)
            if (err) {
                // emit event that uncompressed file is ready
                console.log(`SafeStream: ${err}`)
                if (info) {
                    info.setSize(bw)
                    this.matron.emit("datafile", info.toInfo())
                }
            } else {
                // emit event that compressed file is ready, need to get the compressed size first...
                if (info) {
                    info.statFile(path+'.gz')
                    .then(() => this.matron.emit("datafile", info.toInfo()))
                    .catch((e) => console.log(`SafeStream: ${e} for ${path}.gz`))
                }
            }
            if (stderr) console.log(stderr)
        })
    }

    // closes the current file, if one is open, and leaves it that way: the next write() will
    // lazily open a fresh one. Not opening a new file here (unlike the old version) is what
    // stops an idle stream (e.g. no PPM/FSK dongle attached) from producing an endless trickle
    // of empty files every chunksecs.
    end () {
        if (this.chunkTimer) { clearTimeout(this.chunkTimer); this.chunkTimer = null }
        if (this.sout && this.sout.stream) {
            // set-up on-close listener that gzips the file, this ensures that the underlying
            // file descriptor is actually closed by the time gzip runs
            const path = this.sout.path // capture before it gets overwritten
            const bw = this.bytesWritten
            const info = this.info
            // this.sout.stream.on('close', () => this.gzip(path, info, bw))
            this.sout.stream.on('close', () => {
                OpenFiles = OpenFiles.filter(f => f != path)
                if (info) {
                    info.setSize(bw)
                    this.matron.emit("datafile", info.toInfo())
                }
            })
            // now end the stream
            this.sout.stream.end()
        }
        this.sout = null
    }

    streamError (e) {
        console.log("SafeStream: stream error: " + e)
        this.end()
        // retry writing last data (write() re-opens lazily); may lead to some
        // of lastData being written to two different files
        if (this.lastData)
            this.write(this.lastData)
    }

    // gpsSetClock events may signal that the clock precision has changed, we start a fresh file
    // if it switches to/from "P", which is "unsynchronized", this because the date with 'P' may be
    // bogus and may have to be manually corrected later
    gpsSetClock (d) {
        if (!this.sout) return // nothing open yet; the eventual first write() will pick up the current tscode
        let tscode = Chrony.timeStampCode()
        if ((tscode == "P") != (this.tscode == "P")) {
            console.log(`SafeStream: tscode changed from ${this.tscode} to ${tscode}`)
            this.end()
        }
    }
}

exports.SafeStream = SafeStream
