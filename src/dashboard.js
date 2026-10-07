// dashboard - Event listeners and formatters for the web dashboard
// Copyright ©2021 Thorsten von Eicken, see LICENSE

const AR = require('archiver')
const Path = require('path')
const CP = require('child_process')
//const Pam = require('authenticate-pam')
const Fs = require('fs')
const crypto = require('crypto')
const TimeSeries = require('./timeseries.js')


const top100k = Fs.readFileSync("/opt/sensorgnome/web-portal/top-100k-passwords.txt").toString().split('\n')

const TAGDBFILE   = "/etc/sensorgnome/SG_tag_database.sqlite" // FIXME: needs to come from main.js...
const wifi_hotspot = "/opt/sensorgnome/wifi-button/wifi-hotspot.sh"
const remote_access = "/etc/sensorgnome/remote.json"
const SixfabUpsHat = "/opt/sensorgnome/ups-hat/ups_manager.py"
const vnstat = "/usr/bin/vnstat"
const ts_dir = "/data/ts"

const LotekFreqs = [ 166.380, 150.100, 150.500 ]

// Maps dBm to a human-readable quality label; poor/good are the dBm boundary values.
function signalQuality(dbm, poor, good) {
    if (dbm == null) return 'None'
    if (dbm < poor)  return 'Poor'
    if (dbm < good)  return 'Good'
    return 'Excellent'
}

// Returns a hex colour sweeping red→amber→green across the gauge's dBm range.
// flexdash 0.4.90's color2hhex() only handles hex and Vuetify named colours, not hsl().
function signalColor(dbm, min, max) {
    if (dbm == null) return '#9E9E9E'
    const t = Math.max(0, Math.min(1, (dbm - min) / (max - min)))
    const h = t * 120, s = 0.7, l = 0.4
    const a = s * Math.min(l, 1 - l)
    const f = n => {
        const k = (n + h / 30) % 12
        const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
        return Math.round(255 * c).toString(16).padStart(2, '0')
    }
    return `#${f(0)}${f(8)}${f(4)}`
}

// Port colour matching usb-port-map.vue's portFill logic.
function devPortColor(type, freq) {
    const t = (type || '').toLowerCase()
    if (t === 'cttblu') return '#7C3AED'              // CTT Blū / 2.4 GHz FSK
    const f = parseFloat(freq)
    if (!isNaN(f) && f > 0) {
        if (f > 430 && f < 436) return '#7C3AED'  // FSK UHF
        if (f > 140 && f < 200) return '#0D9488'  // PPM VHF
        return '#6B7280'
    }
    if (t.startsWith('rtlsdr') || t.startsWith('airspy') || t === 'funcubeproplus') return '#7C3AED'
    if (t === 'funcubepro' || t === 'usbaudio') return '#0D9488'
    return '#6B7280'
}

// Read a named devParam's configured value from the matching acquisition plan.
// Accepts an optional port for port-specific lookup (last-match semantics).
function getAcqParam(devType, paramName, port) {
    const plan = port != null
        ? Acquisition.lookup(String(port), devType)?.plan
        : (() => {
            let last = null
            for (const p of (Acquisition.plans || [])) {
                try { if (new RegExp(p.key.devType).test(devType)) last = p } catch {}
            }
            return last
        })()
    if (!plan) return null
    const param = (plan.devParams || []).find(p => p.name === paramName)
    return param?.schedule?.value ?? null
}

// The Dashboard class communicates between the web UI (FlexDash) and the "core" processing,
// mainly using the "Matron" event system. It consists of a number of handlers divided into two
// groups: the "handleSomeEvent" handlers that react to Matron events and propagate the data to
// the dashboard, and the "handle_dash_some_event" handlers that react to user input events
// from the dashboard and cause some changes to occur.
class Dashboard {

    constructor(matron) {
        this.matron = matron

        // ===== Event listeners
        for (const ev of [
            // normal events funneled through matron (i.e. from app)
            'gotGPSFix', 'chrony', 'gotTag', 'setParam', 'setParamError', 'devAdded', 'devRemoved',
            'df', 'sdcardUse', 'vahData', 'grhData', 'netDefaultRoute', 'netInet', 'netMotus', 'netWifiState',
            'sysmonitorData',
            'netHotspotState', 'netWifiConfig', 'portmapFile', 'tagDBInfo', 'motusRecv',
            'motusUploadResult', 'netDefaultGw', 'netDNS', 'lotekFreq', 'netCellState', 'netCellReason', "netScanStatus",
            'netCellInfo', 'netCellConfig', 'cttRadioVersion', 'digibabelRadioVersion', 'nanobabelIdentified', 'cttBluIdentified', 'bluDetection', 'vahRate', 'vahFrames', 'devState',
            'rtlInfo', 'acquisition', 'gotBurst','airspyInfo',
            "enpi_light_status", "enpi_air_status", "enpi_light_toggle", "enpi_air_toggle","enpi_air_gotData","enpi_light_gotData",
            'enpi_status', 'enpi_sample_rate','enpi_sample_schedule','enpi_aws_buket_name', 'enpi_upload_status',
            'enpi_upload_log','enpi_upload_gotData','enpi_update_log', 'enpi_version',
            'enpi_provisioning_status', 'enpi_provisioning_info',
            
            // dashboard events triggered by a message from FlexDash
            'dash_enpi_toggle','dash_enpi_sample_rate','dash_enpi_sample_schedule','dash_enpi_download',
            'dash_enpi_force_upload','dash_enpi_upload_config', 'dash_enpi_provision',
            'dash_download', 'dash_upload', 'dash_deployment_update', 'dash_enable_wifi',
            'dash_enable_hotspot', 'dash_config_wifi', 'dash_update_portmap', 'dash_creds_update',
            'dash_upload_tagdb', 'dash_df_enable', 'dash_df_tags', 'dash_software_reboot',
            'dash_software_enable', 'dash_software_check', 'dash_software_upgrade',
            'dash_allow_shutdown', 'dash_software_shutdown', 'dash_software_restart',
            'dash_download_logs', 'dash_lotek_freq_change', 'dash_config_cell', 'dash_toggle_train',
            'dash_remote_cmds', 'dash_detection_range', 'dash_alter_bootCount', 'dash_enable_agc',
            "dash_enpi_air_toggle", "dash_enpi_light_toggle", "dash_enpi_detection_range", "dash_enpi_secrets_file",
            'dash_enpi_update',
            'dash_gnuradio_enabled',
            'dash_show_pulses', 'dash_cellular_priority', 'dash_burstfinder_burst',
            'dash_burstfinder_filter_file', 'dash_burstfinder_filter_ui',
            'dash_burstfinder_method', 'dash_cell_debug', 'dash_cell_scan',
            'dash_scan_carriers', 'dash_scan_carriers_enable',
            'netCellSeenImsi', 'netCellBadImsi', 'dash_cell_bad_imsi',
            'netCellSignal', 'netWifiSignal', 'dash_enable_cell', 'netWifiIP',
            'netWifiNetworks', 'netWifiScanEnabled', 'netCellICCID', 'dash_cellular_iccid_show',
            'dash_wifi_networks_scan',
            'dash_wifi_connect_ssid', 'dash_wifi_connect_password', 'dash_wifi_connect'
        ]) {
            this.matron.on(ev, (...args) => {
                let fn = 'handle_'+ev
                try {
                    if (!(fn in this)) console.log("Missing Dashboard handler:", ev)
                    else if (args.length <= 1) this[fn](...args)
                    else this[fn](...args)
                } catch(e) {
                    console.log(`Handler ${fn} failed:`, e)
                }
            })
        }

        // keep track of data file summary stats
        matron.on("data_file_summary", (stats) => FlexDash.set('data_file_summary', stats))
        matron.on("detection_stats", (hourly, daily) => this.updateDetectionStats(hourly, daily))
        // Global device reset — triggered by a FlexDash button with output "config_reset"
        matron.on("dash_config_reset", () => this.handle_config_reset())

        // 5 minutes of detections in 10 second bins for sparklines
        this.detections = {
            ctt: Array(5*6).fill(null),
            blu: Array(5*6).fill(null),
            lotek: Array(5*6).fill(null)
        }
        this.detection_log = []

        // direction finding log
        this.df_enable = false
        this.df_tags = {tag1: "1.1", tag2: '78664c3304'}
        this.df_log = []

        // device connection/mode/gain log
        this.devices_log = []

        // time-series
        this.ts = {}
        this.tsRefreshInterval = null
        this.uniqueTagBuckets = {} // port -> [{bucket, tags: Set}, ...one per range]
        this.tagBuffer = []        // [{time, port, tagId}] rolling window for tally
        this.portMeta = {}         // port -> {portPath} for tally column labels
        Fs.mkdirSync(ts_dir, {recursive: true})
        this.ts_sysmon = {
            cpu:  new TimeSeries(ts_dir, 'sysmon-cpu'),
            temp: new TimeSeries(ts_dir, 'sysmon-temp'),
            mem:  new TimeSeries(ts_dir, 'sysmon-mem'),
            disk: new TimeSeries(ts_dir, 'sysmon-disk'),
        }
        this.handle_dash_detection_range(TimeSeries.ranges[0])
        setInterval(() => this.tsSave(), 60000)

        this.pulse_ts = [] // timestamp of last pulse per port

        // prime some data
        setTimeout(() => {
            this.handle_motusRecv({})
            this.handle_devState()
            this.handle_acquisition(Acquisition)
        }, 1000)

        console.log("Dashboard handlers registered")
    }
    
    start() {
        // register download handler with FlexDash
        FlexDash.registerGetHandler("/data-download/:what", (req, res) => this.data_download(req, res))
        FlexDash.registerGetHandler("/logs-download/:what", (req, res) => this.logs_download(req, res))

        setInterval(() => this.detectionShifter(), 10000)

        //setInterval(() => this.tsGenRandom(), 8300)

        // set (relatively) static data
        this.setDeployment()
        FlexDash.set('acquisition', JSON.stringify(Acquisition, null, 2))
        FlexDash.set('net_hotspot_ssid', Machine.machineID)
        this.setDashCreds({ current_password: "?????????", new_password: "", confirm_new_password: ""})
        this.setRemoteManagement()

        // some static machine info
        FlexDash.set('machineinfo', Machine)
        setTimeout(()=>FlexDash.set('machineinfo', Machine), 15000) // sdCardSize comes delayed
        FlexDash.set('portmap/refimage', this.portmapRefImage())
        FlexDash.set('software/enable', false)
        FlexDash.set('software/enable_upgrade', false)
        FlexDash.set('software/enable_shutdown', false)
        this.allow_poweroff = false
        FlexDash.set("software/available", "Not yet checked...")
        FlexDash.set("software/log", "- empty -")
        this.setDashTrain()
        this.getUptime()
        this.matron.on("gpsSetClock", () => this.getUptime())

        // direction finding info is not saved between restarts...
        FlexDash.set('df_enable', 'OFF')
        FlexDash.set('df_tags', this.df_tags)
        FlexDash.set('df_log', "")
        FlexDash.set('devices_log', "")
        FlexDash.set('rtl_sdr_gain', {})
        FlexDash.set('airspy_gain', {})
        FlexDash.set('lotek_show_pulses', "on")
        this.show_pulses = true
        FlexDash.set('cellular/iccid', '**********************')
        FlexDash.set('wifi/connect/enabled', false)
        FlexDash.set('wifi/ssid', 'No network')

        FlexDash.monitoring = this.monitoring.bind(this)

        //this.startUpsHatUpdater()

        setTimeout(() => this.updateNetUsage(), 10*1000)
        setInterval(() => this.updateNetUsage(), 300*1000)

        this.rebuildDevicePanelWidgets()
    }

    // Build the widget config array for a single device port used by DynamicPanel.
    // Row 1 (cols 1+1+2+2=6): port | port_path | type | status
    // Row 2 (cols vary):       freq[2] | Config button[4]  (radio types only)
    // The Config button pops up the GRH/attn/payload-encoding toggles and dropdowns that
    // used to sit directly in row 2 (see configWidgets below).
    // Widget layout is device-type-specific; cols values map to the 6-column internal grid.
    buildDeviceWidgets(port) {
        const dev = HubMan.devs[port]
        if (!dev) return []
        const typeLow = (dev.attr?.type || '').toLowerCase()

        const isCTT       = typeLow === 'ctt/cornellrcvr' || typeLow.startsWith('cttv')
        const isCTTBlu    = typeLow === 'cttblu'
        const isDigiBabel = typeLow.startsWith('digibabel')
        const isNanoBabel = typeLow === 'nanobabel'
        const isAirSpyHF  = typeLow === 'airspyhf'
        const isAirSpy    = typeLow === 'airspy' || isAirSpyHF || typeLow.startsWith('airspy/')
        const isFunCube   = typeLow === 'funcubeproplus' || typeLow === 'funcubepro'
        const isRTL       = typeLow === 'rtlsdr' || typeLow.startsWith('rtlsdr/')
        const isSQM       = typeLow.startsWith('sqm')

        const showFreq  = true; //isNanoBabel || isAirSpy || isFunCube || isRTL
        const showGRH   = isNanoBabel || isAirSpy || isFunCube || isRTL
        const grhFixed  = isAirSpy   // AirSpy/AirSpyHF GRH is always on; cannot switch to VAH
        const showGain  = isAirSpy || isFunCube || isRTL  // NanoBabel has no gain control

        const resetBtn = {
            kind: "PushButton", float_position: "top-right",
            static: { icon: "mdi-restore", color: "grey-darken-1", variant: "plain", title: "", output_value: port },
            output: `device_reset/${port}`,
        }

        // Row 1: port[1] port_path[1] type[2] status/sensor[2]
        const innerWidgets = [
            { kind: "Label", cols: 1, static: { label: `${port}`, size: "200%", weight: "700", justify: "left" }, dynamic: { color: `devices/${port}/color` } },
            { kind: "Label", cols: 1, static: { justify: "left" }, dynamic: { label: `devices/${port}/port_path` } },
            { kind: "Label", cols: 2, static: { justify: "left" }, dynamic: { label: `devices/${port}/type` } },
            resetBtn,
        ]

        if (isSQM) {
            innerWidgets.push({ kind: "Stat", cols: 2, static: { value: "SENSOR", zoom: 0.7 } })
            return { kind: "DynamicPanel", cols: 6, static: { card: true, widgets: innerWidgets } }
        }

        innerWidgets.push({
            kind: "Stat", cols: 2,
            static: { zoom: 0.7, high_regexp: "running", high_color: "green-darken-3", low_regexp: "(stopped|error)", low_color: "red-darken-3" },
            dynamic: { value: `devices/${port}/state` },
        })


        // Row 2: spacer[1] freq[1] config button[4]
        if (showFreq) {
            innerWidgets.push({
                kind: "Label", cols: 2,
                static: {},
                dynamic: { label: `devices/${port}/frequency` },
            })
        }

        // Config controls (toggles/dropdowns) are collected here and shown in a "Config"
        // pop-up button rather than laid out directly in the device panel.
        const configWidgets = []

        if (isDigiBabel) {
            configWidgets.push({ kind: "Toggle", cols: 2, static: { value: "No payload", enabled: false, show_value: true, off_value: "No payload", on_value: "Payload" } })
            configWidgets.push({ kind: "Toggle", cols: 2, static: { value: "CTT encoding", enabled: false, show_value: true, off_value: "CTT encoding", on_value: "Lotek encoding" } })
        }

        if (showGRH) {
            if (isNanoBabel) {
                // NanoBabel has no VAMP pulse-detect plan and no GRH support; show fixed "NB" label
                configWidgets.push({ kind: "Toggle", cols: 2, static: { value: "NB", enabled: false, show_value: true, on_value: "NB", off_value: "NB" } })
            } else if (grhFixed) {
                configWidgets.push({ kind: "Toggle", cols: 2, static: { value: "GRH", enabled: false, show_value: true, on_value: "GRH", off_value: "VAH" } })
            } else {
                configWidgets.push({
                    kind: "Toggle", cols: 2,
                    static: { show_value: true, on_value: "GRH", off_value: "VAH" },
                    dynamic: { value: `devices/${port}/grh` },
                    output: `dev_grh/${port}`,
                })
            }
        }

        if (showGain) {
            let choices, labels, defaultVal
            if (isAirSpyHF) {
                // RF gain in dB: 0 = max sensitivity (no attenuation), -48 = max attenuation.
                choices = ["0","-6","-12","-18","-24","-30","-36","-42","-48"]
                labels  = ["0 dB","-6 dB","-12 dB","-18 dB","-24 dB","-30 dB","-36 dB","-42 dB","-48 dB"]
                defaultVal = String(getAcqParam('airspyhf', 'sensitivity_gain', port) ?? 0)
            } else if (isAirSpy) {
                choices = Array.from({length: 22}, (_, i) => String(i)); labels = choices
                defaultVal = String(getAcqParam('airspy', 'sensitivity_gain', port) ?? 12)
            } else if (isFunCube) {
                choices = ["0","1"]; labels = ["LNA off","LNA on"]; defaultVal = "1"
            } else {
                // RTL-SDR / NanoBabel: gain in dB. hw_setParam multiplies by 10 for rtl_tcp.
                // rtlInfo also reports in dB (gotCmdReply divides rtl_tcp's 0.1 dB units by 10).
                choices = ["0","7.7","14.4","20.7","29.7","38.6","40.2","43.9","49.6"]
                labels  = ["0 dB","7.7 dB","14.4 dB","20.7 dB","29.7 dB","38.6 dB","40.2 dB","43.9 dB","49.6 dB"]
                const rawGain = getAcqParam(isNanoBabel ? 'rtlsdr' : typeLow, 'tuner_gain', port) ?? 29.7
                defaultVal = String(rawGain)
            }
            configWidgets.push({
                kind: "DropdownSelect", cols: 2,
                static: { choices, labels, value: defaultVal, color: "white" },
                dynamic: { value: `devices/${port}/attn`, enabled: `devices/${port}/gain_enabled` },
                output: `dev_attn/${port}`,
            })
        }

        if (configWidgets.length) {
            innerWidgets.push({
                kind: "PopupButton", cols: 4,
                static: { title: "Config", icon: "cog", color: "grey-darken-1", widgets: configWidgets },
            })
        }

        return { kind: "DynamicPanel", cols: 6, static: { card: true, widgets: innerWidgets } }
    }

    // Rebuild and publish the per-device panel array; one DynamicPanel card per device
    rebuildDevicePanelWidgets() {
        const widgets = []
        for (const port of Object.keys(HubMan.devs).sort((a, b) => parseInt(a) - parseInt(b))) {
            widgets.push(this.buildDeviceWidgets(port))
        }
        FlexDash.set('device_panel_widgets', widgets)
    }

    handle_dev_freq(port, freq) {
        const f = parseFloat(freq)
        if (isNaN(f) || f < 100 || f > 1000) {
            console.log(`Device port ${port}: invalid frequency value ${freq}`)
            return
        }
        FlexDash.set(`devices/${port}/frequency`, `${f} MHz`)
        this.matron.emit('devFreqChg', { port, freq: f })
        console.log(`Device port ${port}: frequency set to ${f} MHz`)
    }

    handle_dev_grh(port, value) {
        const grh = value === "GRH" || value === true || value === 'true' || value === 1
        const modeStr = grh ? "GRH" : "VAH"

        const typeLowG = (HubMan.devs[port]?.attr?.type || '').toLowerCase()

        // Block VAH switch when the plan has only GnuRadio plugins: VAH crashes trying to
        // load a Python plugin via VAMP (exit code 11), triggering a re-enumeration loop.
        if (!grh) {
            const devType = HubMan.devs[port]?.attr?.type || ''
            const acqPlan = Acquisition.lookup(port, devType)?.plan
            if (acqPlan?.pulseFinder === 'gnuradio') {
                FlexDash.set(`devices/${port}/grh`, 'GRH')
                this.devicesLogPush(`Port ${port}: VAH unavailable — plan has only GnuRadio plugins`)
                return
            }
        }

        FlexDash.set(`devices/${port}/grh`, modeStr)
        FlexDash.set(`devices/${port}/gain_enabled`, !(typeLowG === 'funcubepro' && grh))

        this.devicesLogPush(`Port ${port}: switching to ${modeStr}...`)

        // Store per-device override so sensor.js getSensor picks it up on re-init,
        // and persist to acquisition.json so it survives restarts.
        if (!Acquisition.devModeOverrides) Acquisition.devModeOverrides = {}
        Acquisition.devModeOverrides[port] = modeStr
        const devTypeG = HubMan.devs[port]?.attr?.type || ''
        if (devTypeG) Acquisition.setPortPlan(port, devTypeG, { pulseFinder: grh ? 'gnuradio' : null })

        const dev = HubMan.devs[port]
        if (!dev) return

        // Deep clone so the original reference is safe to delete from HubMan.devs
        const devCopy = JSON.parse(JSON.stringify(dev))
        devCopy.attr.radio = modeStr
        devCopy.state = 'init'

        // Mark this removal as intentional so handle_devRemoved doesn't clear the override.
        // Any subsequent unexpected removal (VAH/GRH crash) will clear it, ending crash loops.
        if (!this._intentionalRemove) this._intentionalRemove = new Set()
        this._intentionalRemove.add(port)

        this.matron.emit('devRemoved', devCopy)
        delete HubMan.devs[port]

        // Audio devices share their ALSA handle; RTL-SDR/USB devices also need time for
        // the GnuRadio subprocess to release the USB device before rtl_tcp can open it.
        const isAudioDev  = typeLowG === 'funcubepro' || typeLowG === 'funcubeproplus'
        const isFromGRH   = !grh && (dev.attr?.radio === 'GRH')
        const delay = isAudioDev ? 2000 : (isFromGRH ? 3000 : 500)

        setTimeout(() => {
            HubMan.devs[port] = devCopy
            this.matron.emit('devAdded', devCopy)
            this.devicesLogPush(`Port ${port}: ${modeStr} active`)
        }, delay)
    }

    handle_dev_attn(port, value) {
        const v = String(value)
        FlexDash.set(`devices/${port}/attn`, v)

        const dev = HubMan.devs[port]
        if (!dev) { console.log(`Device port ${port}: not found for gain change`); return }

        const typeLow = (dev.attr?.type || '').toLowerCase()
        const isAirSpyHF = typeLow === 'airspyhf'
        const isAirSpy   = typeLow === 'airspy' || isAirSpyHF || typeLow.startsWith('airspy/')
        const isRTL      = typeLow === 'rtlsdr' || typeLow.startsWith('rtlsdr/')
        const isFunCube  = typeLow === 'funcubeproplus' || typeLow === 'funcubepro'
        const isNanoBabel = typeLow === 'nanobabel'

        let par
        if (isAirSpy)              par = 'sensitivity_gain'
        else if (isRTL || isNanoBabel) par = 'tuner_gain'
        else if (isFunCube)        par = 'lna_gain'

        if (!par) { console.log(`Device port ${port}: no gain param for type ${typeLow}`); return }

        this.matron.emit('requestSetParam', { port, par, val: v })
        Acquisition.updateDevParam(dev.attr.type, par, parseFloat(v))
        Acquisition.setPortPlan(port, dev.attr.type, { devParams: { [par]: parseFloat(v) } })
        this.devicesLogPush(`Port ${port}: ${par} → ${v}`)
    }

    // Reset one device: delete its port-specific acquisition plan, clear in-memory override,
    // and re-initialize the device so the base wildcard plan takes effect immediately.
    handle_device_reset(port) {
        const dev = HubMan.devs[port]
        if (!dev) return
        Acquisition.resetPortPlan(port)
        if (Acquisition.devModeOverrides) delete Acquisition.devModeOverrides[port]
        this.devicesLogPush(`Port ${port}: reset to default acquisition settings`)

        const devCopy = JSON.parse(JSON.stringify(dev))
        devCopy.state = 'init'
        if (!this._intentionalRemove) this._intentionalRemove = new Set()
        this._intentionalRemove.add(port)
        this.matron.emit('devRemoved', devCopy)
        delete HubMan.devs[port]
        setTimeout(() => {
            HubMan.devs[port] = devCopy
            this.matron.emit('devAdded', devCopy)
        }, 500)
    }

    // Reset all devices: delete all port-specific acquisition plans, clear all overrides,
    // and re-initialize every connected device. Triggered via FlexDash output 'config_reset'.
    handle_config_reset() {
        Acquisition.resetAllPortPlans()
        if (Acquisition.devModeOverrides) Acquisition.devModeOverrides = {}
        this.devicesLogPush('All devices: reset to default acquisition settings')

        const devCopies = Object.entries(HubMan.devs).map(([p, dev]) => {
            const copy = JSON.parse(JSON.stringify(dev))
            copy.state = 'init'
            if (!this._intentionalRemove) this._intentionalRemove = new Set()
            this._intentionalRemove.add(p)
            this.matron.emit('devRemoved', copy)
            delete HubMan.devs[p]
            return [p, copy]
        })
        setTimeout(() => {
            for (const [p, copy] of devCopies) {
                HubMan.devs[p] = copy
                this.matron.emit('devAdded', copy)
            }
        }, 1000)
    }

    devicesLogPush(msg) {
        const ts = new Date().toISOString().replace(/.*T/, '').replace(/\..+/, '')
        this.devices_log.push(`${ts} ${msg}`)
        if (this.devices_log.length > 200) this.devices_log.splice(0, this.devices_log.length - 200)
        FlexDash.set('devices_log', this.devices_log.join('\n'))
    }

    getUptime() {
        let uptime = parseInt(Fs.readFileSync("/proc/uptime").toString(), 10)
        if (!(uptime > 0)) uptime = 0
        FlexDash.set('boot_time', Date.now() / 1000 - uptime)
    }
    
    // generate info about a device, called on devAdded
    genDevInfo(dev) {
        var info = {
            port: dev.attr.port,
            port_path: (dev.attr["port_path"] || "--").replace(/\_/g, '.'),
            type: dev.attr.type,
        }
        // switch (dev.attr.type) {
        // case "gps": info.attr = dev.attr.kind; break
        // case "CTT/CornellRcvr": info.attr = "433Mhz"; break
        // case "funcubeProPlus": info.attr = "?Mhz"; break
        // case "funcubePro": info.attr = "?Mhz"; break
        // case "rtlsdr": info.type = dev.attr.prod; info.attr = "?Mhz"; break
        // }
        return info
    }

    handle_rtlInfo(port, info) {
        if (!port) return
        if (info?.tuner_type) FlexDash.set(`devices/${port}/type`, 'rtlsdr/'+info.tuner_type)
        if (info?.tuner_gain != null) FlexDash.set(`devices/${port}/attn`, String(info.tuner_gain))
    }

    handle_airspyInfo(port, info) {
        if (!port) return
        if (info?.tuner_type) FlexDash.set(`devices/${port}/type`, 'airspy/'+info.tuner_type)
        if (info?.sensitivity_gain != null) FlexDash.set(`devices/${port}/attn`, String(info.sensitivity_gain))
    }
    handle_dash_alter_bootCount(obj) {
        if (!obj?.bootCount) return
        const bc = parseInt(obj.bootCount)
        if (bc < 1 || bc > 1000) return
        console.log("Setting bootCount to", bc)
        Machine.bootCount = bc
        FlexDash.set('machineinfo', Machine)
        Fs.writeFileSync("/etc/sensorgnome/bootcount", bc.toString() + '\n')
    }

    // update the number of radios connected on devAdded/Removed
    updateNumRadios() {
        return {
            fsk: Object.values(HubMan.devs).filter(d =>
                d.attr?.radio?.startsWith("CTT") ||
                d.attr?.radio == "DigiBabel" || d.attr?.radio == "NanoBabel").length,
            ppm: Object.values(HubMan.devs).filter(d => ["VAH", "GRH"].includes( d.attr?.radio) ).length,
        //    grh: Object.values(HubMan.devs).filter(d => d.attr?.radio == "GRH").length,
            sensors: Object.values(HubMan.devs).filter(d => d.attr?.radio == "none").length,
            all: Object.values(HubMan.devs).filter(d => d.attr?.radio && d.attr?.radio != "none" ).length,
            // bad: radios with invalid port
            bad: Object.keys(HubMan.devs).filter(p => (p < 0 || p > 20) && HubMan.devs[p].attr?.radio).length,
        }
    }

    // update the state of all the radios, triggered by devAdded/Removed and also devState
    handle_devState() {
        setTimeout(() => { // give HubMan a chance to process the devState event first
            const green = "#4CAF50", red = "#F44336", yellow = "#FFC107"
            let color = green, cnt = 0, text = []
            for (const dev of Object.values(HubMan.devs).filter(dev => dev.attr?.radio != "none")) {
                switch (dev.state) {
                case "running":
                    text.push(`port ${dev.attr?.port} is running OK`)
                    break;
                case "init":
                    if (color == green) color = yellow
                    cnt++
                    text.push(`port ${dev.attr?.port} is initializing`)
                    break;
                case "error":
                    color = red
                    cnt++
                    text.push(`port ${dev.attr?.port}: "${dev.msg}"`)
                    break;
                default:
                    if (color == green) color = yellow
                    cnt++
                    text.push(`port ${dev.attr?.port}: ${dev.state}`)
                    break;
                }
                if (dev.attr?.radio < 1 || dev.attr?.radio > 10) {
                    color = red
                    cnt++
                    text.push(`port ${dev.attr?.port}: invalid port, must be in range [1..10]`)
                }
            }
            text = cnt > 0 ? text.join('\n\n') : ''
            const title = cnt>0 ? `${cnt} errors` : '--'
            //console.log("Radio state:", JSON.stringify({ color, enabled: cnt>0, title, text }))
            FlexDash.set('radio_state', { color, enabled: cnt>0, errors: cnt, title, text }) // title doesn't work :-(
            // update per-device state display
            for (const [port, dev] of Object.entries(HubMan.devs)) {
                if (dev.state !== undefined) FlexDash.set(`devices/${port}/state`, dev.state)
            }
        }, 10)
    }
    
    handle_gotGPSFix(fix) { FlexDash.set('gps', fix) } // {lat, lon, alt, time, state, ...}
    handle_chrony(info) { FlexDash.set('chrony', info) } // {rms_error, time_source}
    handle_df(info) { FlexDash.set('df', info) } // {source, fstype, size, used, use%, target}
    handle_sdcardUse(pct) { FlexDash.set('sdcard_use', pct) }
    handle_sysmonitorData({ cpu, temp, memUsedPct, memAvailMB, diskPct }) {
        const now = Date.now()
        if (cpu     != null) { this.ts_sysmon.cpu.avg(now, cpu);      FlexDash.set('system/cpu', cpu) }
        if (temp    != null) { this.ts_sysmon.temp.avg(now, temp);    FlexDash.set('system/temp', temp) }
        if (memUsedPct != null) { this.ts_sysmon.mem.avg(now, memUsedPct); FlexDash.set('system/mem_pct', memUsedPct) }
        if (memAvailMB != null) FlexDash.set('system/mem_avail_mb', memAvailMB)
        if (diskPct != null) { this.ts_sysmon.disk.avg(now, diskPct); FlexDash.set('system/disk', diskPct) }
        this.sysmonShow()
    }
    sysmonShow() {
        const now = Date.now()
        const range = TimeSeries.ranges[this.ts_ix]
        const keys = Object.keys(this.ts_sysmon)
        const labels = ['cpu %', 'temp °C', 'mem %', 'disk %']
        const [times, first] = this.ts_sysmon[keys[0]].get(range, now)
        const data = times.map((t, i) => [Math.floor(t / 1000), first[i]])
        for (let k = 1; k < keys.length; k++) {
            const [, values] = this.ts_sysmon[keys[k]].get(range, now)
            for (let j = 0; j < data.length; j++) data[j].push(values[j])
        }
        FlexDash.set('system/graphs', { data, labels, title: `system (${range})` })
    }
    handle_setParam(info) { } // FlexDash.set('param', info) } // {param, value, error}
    handle_setParamError(info) { } // FlexDash.set('param', info) } // {param, error}
    handle_devAdded(info) {
        const port = info.attr.port
        FlexDash.set(`devices/${port}`, this.genDevInfo(info))
        FlexDash.set(`devices/${port}/state`, info.state || 'init')
        // Determine actual mode from plan.pulseFinder + per-port override, mirroring getSensor.
        // Cannot rely on info.attr?.radio — hubman stamps rtlsdr/funcubeProPlus as 'GRH' from the
        // filesystem regardless of whether the plan defaults to VAH.
        {
            const portOvr = Acquisition.devModeOverrides?.[port]
            const devTypeFP = info.attr?.type || ''
            const acqPlanFP = Acquisition.lookup(port, devTypeFP)?.plan
            const useGRH_FP = portOvr === 'GRH' || (portOvr !== 'VAH' && acqPlanFP?.pulseFinder === 'gnuradio')
            FlexDash.set(`devices/${port}/grh`, useGRH_FP ? 'GRH' : 'VAH')
        }
        const tDA = (info.attr?.type || '').toLowerCase()
        const devFreq = ['VAH', 'GRH'].includes(info.attr?.radio) && Acquisition.lotek_freq != null
            ? `${Acquisition.lotek_freq} MHz`
            : tDA === 'cttblu'
                ? "2400 MHz"
                : (tDA === 'ctt/cornellrcvr' || tDA.startsWith('cttv') || tDA.startsWith('digibabel'))
                    ? "434 MHz"
                    : null
        FlexDash.set(`devices/${port}/frequency`, devFreq)
        // Initialize attn from the plan's default so the gain dropdown shows a selection.
        // Mirrors the defaultVal logic in buildDeviceWidgets; uses original-case type for
        // case-sensitive plan regex matching (e.g. ".*funcubeProPlus").
        {
            const adType = info.attr?.type || ''
            const adTypeLow = adType.toLowerCase()
            const adIsAHF = adTypeLow === 'airspyhf'
            const adIsAS  = adTypeLow === 'airspy' || adIsAHF || adTypeLow.startsWith('airspy/')
            const adIsRTL = adTypeLow === 'rtlsdr' || adTypeLow.startsWith('rtlsdr/')
            const adIsNB  = adTypeLow === 'nanobabel'
            const adIsFC  = adTypeLow === 'funcubeproplus' || adTypeLow === 'funcubepro'
            let initialAttn = null
            if (adIsAHF) {
                initialAttn = String(getAcqParam('airspyhf', 'sensitivity_gain', port) ?? 0)
            } else if (adIsAS) {
                initialAttn = String(getAcqParam('airspy', 'sensitivity_gain', port) ?? 12)
            } else if (adIsRTL || adIsNB) {
                const rawGain = getAcqParam(adIsNB ? 'rtlsdr' : adType, 'tuner_gain', port) ?? 29.7
                initialAttn = String(rawGain)  // dB; hw_setParam multiplies ×10 for rtl_tcp
            } else if (adIsFC) {
                initialAttn = "1"  // LNA on by default
            }
            FlexDash.set(`devices/${port}/attn`, initialAttn)
        }
        FlexDash.set(`devices/${port}/color`, devPortColor(info.attr?.type, devFreq))

        // Gain available for all devices except funcubePro in GRH mode
        const typeLowDA = (info.attr?.type || '').toLowerCase()
        {
            const portOvr2 = Acquisition.devModeOverrides?.[port]
            const acqPlanGE = Acquisition.lookup(port, info.attr?.type || '')?.plan
            const isGRHMode = portOvr2 === 'GRH' || (portOvr2 !== 'VAH' && acqPlanGE?.pulseFinder === 'gnuradio')
            FlexDash.set(`devices/${port}/gain_enabled`, !(typeLowDA === 'funcubepro' && isGRHMode))
            this.devicesLogPush(`Port ${port}: connected (${info.attr?.type || 'unknown'}, ${isGRHMode ? 'GRH' : 'VAH'})`)
        }
        FlexDash.set(`radios`, this.updateNumRadios())
        this.tsAddDevice(info)
        this.handle_devState()
        if (!this._devHandlers) this._devHandlers = {}
        if (!this._devHandlers[port]) {
            const h = {
                freq:  (v) => this.handle_dev_freq(port, v),
                grh:   (v) => this.handle_dev_grh(port, v),
                attn:  (v) => this.handle_dev_attn(port, v),
                reset: ()  => this.handle_device_reset(port),
            }
            this._devHandlers[port] = h
            this.matron.on(`dash_dev_freq/${port}`, h.freq)
            this.matron.on(`dash_dev_grh/${port}`, h.grh)
            this.matron.on(`dash_dev_attn/${port}`, h.attn)
            this.matron.on(`dash_device_reset/${port}`, h.reset)
        }
        this.rebuildDevicePanelWidgets()
    }
    handle_devRemoved(info) {
        const port = info.attr.port
        this.devicesLogPush(`Port ${port}: disconnected`)

        // If this removal is unexpected (not triggered by our toggle cycle), clear any
        // mode override so the device restarts in its default pipeline mode. This breaks
        // crash loops caused by plan-incompatible mode switches (e.g. funcubeProPlus VAH
        // trying to load a gnuradio-only VAMP plugin).
        if (this._intentionalRemove?.has(port)) {
            this._intentionalRemove.delete(port)
        } else if (Acquisition.devModeOverrides?.[port]) {
            this.devicesLogPush(`Port ${port}: unexpected removal — clearing ${Acquisition.devModeOverrides[port]} override`)
            delete Acquisition.devModeOverrides[port]
        }

        FlexDash.unset(`devices/${port}`)
        FlexDash.set(`radios`, this.updateNumRadios())
        this.tsRemoveDevice(info)
        this.handle_devState()
        if (this._devHandlers?.[port]) {
            this.matron.off(`dash_dev_freq/${port}`, this._devHandlers[port].freq)
            this.matron.off(`dash_dev_grh/${port}`, this._devHandlers[port].grh)
            this.matron.off(`dash_dev_attn/${port}`, this._devHandlers[port].attn)
            this.matron.off(`dash_device_reset/${port}`, this._devHandlers[port].reset)
            delete this._devHandlers[port]
        }
        this.rebuildDevicePanelWidgets()
    }
    handle_digibabelRadioVersion(info) {
        const v = info.version.replace(/\..*/, '')
        FlexDash.set(`devices/${info.port}/type`, 'DigiBabel.v' + v)
    }
    handle_nanobabelIdentified(info) {
        const port = info.port
        FlexDash.set(`devices/${port}/type`, 'NanoBabel')
        FlexDash.set(`devices/${port}/frequency`, "166.380 MHz")
        FlexDash.set(`devices/${port}/color`, devPortColor('NanoBabel', 166.380))
        // attr.radio is now "NanoBabel" — refresh the radio counter
        FlexDash.set(`radios`, this.updateNumRadios())
        // devAdded ran tsAddDevice before the probe completed, so it created a CTT-style
        // time series (because attr.radio was still "DigiBabel"). Recreate it correctly.
        const dev = HubMan.devs[port]
        if (dev) {
            this.tsRemoveDevice(dev)
            this.tsAddDevice(dev)
        }
        // NanoBabel starts life typed as DigiBabel; reclassification changes the widget layout
        this.rebuildDevicePanelWidgets()
    }
    handle_cttBluIdentified(info) {
        const port = info.port
        FlexDash.set(`devices/${port}/type`, 'CTTBlu')
        FlexDash.set(`devices/${port}/frequency`, "2400 MHz")
        FlexDash.set(`devices/${port}/color`, devPortColor('CTTBlu', 2400))
        FlexDash.set('radios', this.updateNumRadios())
        const dev = HubMan.devs[port]
        if (dev) {
            this.tsRemoveDevice(dev)
            this.tsAddDevice(dev)
        }
        this.rebuildDevicePanelWidgets()
    }

    handle_bluDetection(info) {
        const port = String(info.port)
        const channel = info.channel
        const ts = (new Date(info.timestamp * 1000)).toISOString().replace(/.*T/, '').replace(/\..*/, '')
        this.detections.blu[this.detections.blu.length-1]++
        FlexDash.set('detections_5min', this.detections)
        let extra = ''
        if (info.temp != null) extra += ` ${Number(info.temp).toFixed(2)}°C`
        this.detectionLogPush(
            `BLU B${port}-${channel} ${ts}: ${info.tagId} ${info.rssi}dBm${extra}`
        )
        this.tsGotTag(`B${port},${info.timestamp},${info.tagId}`)
    }

    handle_cttRadioVersion(info) {
        const v = info.version.replace(/\..*/, '')
        FlexDash.set(`devices/${info.port}/type`, 'CTTv' + v)
    }
    handle_portmapFile(txt) { FlexDash.set('portmap_file', txt) }

    portmapRefImage() {
        const m = Machine.machineType.match(/Raspberry Pi (\d+)/)
        const gen = m?.[1]
        if (!['3', '4', '5'].includes(gen)) return null
        return `/rpi${gen}-usb-ports.png`
    }
    handle_dash_update_portmap(portmap) { HubMan.setPortmap(portmap) }
    handle_tagDBInfo(data) { FlexDash.set('tagdb', data) }
    handle_motusUploadResult(data) { FlexDash.set('motus_upload', data) }
    handle_lotekFreq(f) {
        FlexDash.set('lotek_freq', f)
        for (const [port, dev] of Object.entries(HubMan.devs)) {
            if (['VAH', 'GRH'].includes(dev.attr?.radio)) {
                FlexDash.set(`devices/${port}/frequency`, `${f} MHz`)
                FlexDash.set(`devices/${port}/color`, devPortColor(dev.attr?.type, f))
            }
        }
    }
    handle_dash_show_pulses(v) {
        FlexDash.set('lotek_show_pulses', v=="on" ? "on" : "off")
        this.show_pulses = v == "on"
    }

    handle_acquisition(config) {
        // update burstfinder config elements
        FlexDash.set('burstfinder',
            Object.fromEntries(Object.entries(config.burstfinder).map((
                [k,v]) => [k, v==true?"on":v==false?"off":v]
        ))
        )
        // sync gnuradio toggle state
        FlexDash.set('gnuradio/enabled', config.gnuradio_enabled)
    }

    handle_dash_gnuradio_enabled(enabled) {
        Acquisition.update({ gnuradio_enabled: enabled })
        this.matron.emit("gnuradioEnabled", enabled)
        HubMan.resetDevices()
    }
    handle_dash_burstfinder_method(v) {
        if (v === 'burstfinder') this.updateBFConfig("method", v)
    }
    handle_dash_burstfinder_filter_file(v) { this.updateBFConfig("filter_file", v=="on") }
    handle_dash_burstfinder_filter_ui(v) { this.updateBFConfig("filter_ui", v=="on") }
    updateBFConfig(key, value) {
        const burstfinder = { ...Acquisition.burstfinder, [key]: value }
        Acquisition.update({ burstfinder })
    }

    // ===== Network / Internet

    // events from WifiMan, propagate to the UI
    handle_netInet(status) { FlexDash.set('net_inet_status', status) }
    handle_netMotus(status) { FlexDash.set('net_motus_status', status) }
    handle_netDefaultRoute(state) { FlexDash.set('net_default_route', state || "none") }
    handle_netDefaultGw(state) { FlexDash.set('net_default_gw', state) }
    handle_netDNS(state) { FlexDash.set('net_dns', state) }
    handle_netHotspotState(state) { FlexDash.set('net_hotspot_state', state || "??") }
    handle_netWifiState(state) {
        FlexDash.set('net_wifi_state', state || "??")
        FlexDash.set('net_wifi_enabled', state != "INACTIVE" ? "ON" : "OFF")
    }
    handle_netWifiConfig(config) {
        config = Object.fromEntries(['country','ssid','passphrase'].map(k=>[k,config[k]]))
        config.passphrase = "********"
        FlexDash.set('net_wifi_config', config)
    }
    handle_netCellState(state) {
        FlexDash.set('cellular/state', state || "??")
        FlexDash.set('cellular/enabled', (state === 'disabled' || state === 'no-modem') ? 'OFF' : 'ON')
    }
    handle_netCellReason(reason) { FlexDash.set('cellular/reason', reason || "") }
    handle_netScanStatus(status) { 
		status = typeof status === "object" ? status : typeof status === "string" ? [status,""] : ["",""]
		FlexDash.set('cellular/scan_status', status[0] || "")
		FlexDash.set('cellular/scan_status_detailed', status[1] || "")
	}
    handle_netCellCarrier(carrier) { FlexDash.set('cellular/carrier', carrier || "Any") }
    handle_netCellCarriers(carriers) { 
		FlexDash.set('cellular/carriers_data', carriers || []) 
		FlexDash.set('cellular/carriers_columns', ["Carrier Code", "Carrier Name", "Technology", "Availability"]) 
	}
    handle_netCellConfig(data) {
        FlexDash.set('cellular/config', data || {})
        FlexDash.set('cellular/config_labels', Object.keys(data||{}))
    }
    handle_netCellInfo(info) {
        FlexDash.set('cellular/info', info || {})
        FlexDash.set('cellular/info_labels', Object.keys(info||{}))
    }
    
    // events from the dashboard, change wifi/hotspot/cell state or settings
    handle_dash_enable_wifi(state) { WifiMan.enableWifi(state == "ON").then(() => {}) }
    handle_dash_enable_hotspot(state) { WifiMan.enableHotspot(state == "ON") }
    handle_dash_config_wifi(config) { WifiMan.setWifiConfig(config).then(() => {}) }
    handle_dash_config_cell(config) { CellMan.setCellConfig(config) }
    handle_dash_enable_cell(state) { CellMan.enableCellular(state === 'ON') }
    handle_dash_scan_carriers() { CellMan.scanCarriers() }
    handle_dash_scan_carriers_enable(enabled) { FlexDash.set('scan_carriers/enable',enabled) }
    handle_dash_cellular_priority(prio) {
        CellMan.setCellPriority(prio)
        setTimeout(()=>CellMan.getCellPriority().then(prio => FlexDash.set('cellular/priority', prio)), 5000)
    }
    handle_dash_cell_debug() {
        CellMan.getCellDebug().then(dbg => FlexDash.set('cellular/debug', dbg))
    }
    handle_dash_cell_scan() {
        FlexDash.set('cellular/debug', "Scan takes 10-20 seconds...")
        CellMan.getCellScan().then(dbg => FlexDash.set('cellular/debug', dbg))
    }
    // Seen-IMSI reference table (populated from check-modem.sh log)
    handle_netCellSeenImsi(rows) {
        FlexDash.set('cellular/telecom/header', ["MCC", "MNC", "Operator", "Region", "Rejected"])
        FlexDash.set('cellular/telecom/data', rows || [])
    }
    // Bad-IMSI table (currently blocked prefixes)
    handle_netCellBadImsi(rows) {
        FlexDash.set('cellular/bad_imsi/header', ["MCC", "MNC", "Operator", "Region"])
        FlexDash.set('cellular/bad_imsi/data', rows || [])
    }
    // User edits the blocked list from the UI; expects array of 5-6 digit prefix strings
    handle_dash_cell_bad_imsi(data) {
        if (!Array.isArray(data)) return
        CellMan.setCellConfig({ 'bad-imsi-prefixes': data })
    }
    handle_netCellSignal(s) {
        FlexDash.set('cellular/signal/dbm',     s?.dbm ?? null)
        FlexDash.set('cellular/signal/label',   s ? `${s.dbm} dBm (${s.rat})` : '—')
        FlexDash.set('cellular/signal/color',   signalColor(s?.dbm, -120, -50))
        FlexDash.set('cellular/signal/quality', signalQuality(s?.dbm, -105, -85))
    }
    handle_netWifiSignal(s) {
        FlexDash.set('net_wifi_signal/dbm',     s?.dbm ?? null)
        FlexDash.set('net_wifi_signal/label',   s ? `${s.dbm} dBm` : '—')
        FlexDash.set('net_wifi_signal/color',   signalColor(s?.dbm, -90, -30))
        FlexDash.set('net_wifi_signal/quality', signalQuality(s?.dbm, -75, -55))
    }
    handle_netWifiIP(ip) { FlexDash.set('net_wifi_ip', ip || '—') }
    handle_netWifiNetworks(rows) {
        rows = rows || []
        this.wifi_networks_rows = rows
        const connected = rows.find(r => r[2] === 'Connected')
        const labels = ['No network', ...rows.map(r => `${r[0]} (${r[1]} dBm)`)]
        FlexDash.set('wifi/available', labels)
        FlexDash.set('wifi/ssid', connected ? connected[0] : 'No network')
        FlexDash.set('wifi/networks/data', rows)
        if (this.wifi_connecting) {
            this.wifi_connecting = false
            if (!connected || connected[0] !== this.wifi_connect_ssid) {
                FlexDash.set('wifi/connect/enabled', true) // connection failed, re-enable
            }
        }
    }
    handle_dash_wifi_connect_ssid(label) {
        if (!label || label === 'No network') {
            FlexDash.set('wifi/connect/enabled', false)
            return
        }
        const row = (this.wifi_networks_rows || []).find(r => `${r[0]} (${r[1]} dBm)` === label)
        this.wifi_connect_ssid = row ? row[0] : label
        this.wifi_connect_password = ''
        FlexDash.set('wifi/ssid', this.wifi_connect_ssid)
        FlexDash.set('wifi/password', '[SET WIFI PASSWORD HERE]')
        FlexDash.set('wifi/connect/enabled', true)
    }
    handle_dash_wifi_connect_password(password) {
        this.wifi_connect_password = password
    }
    handle_dash_wifi_connect() {
        if (!this.wifi_connect_ssid) return
        WifiMan.setWifiConfig({ ssid: this.wifi_connect_ssid, passphrase: this.wifi_connect_password || '' }).then(() => {})
        FlexDash.set('wifi/ssid', this.wifi_connect_ssid)
        FlexDash.set('wifi/password', '********')
        FlexDash.set('wifi/connect/enabled', false)
        this.wifi_connecting = true
        setTimeout(() => WifiMan.scanWifiNetworks(), 12000)
    }
    handle_netCellICCID(iccid) { FlexDash.set('cellular/iccid', iccid || '') }
    handle_dash_cellular_iccid_show() { CellMan.fetchAndRevealICCID() }
    handle_netWifiScanEnabled(enabled) { FlexDash.set('wifi/networks/scan_enabled', enabled) }
    handle_dash_wifi_networks_scan() { WifiMan.scanWifiNetworks() }

    // upload info
    handle_motusRecv(info) {
        const dash = {
            project_id: info.project || "UNSET",
            deployment_status: info.status || "UNKNOWN",
            station_name: info.deployment,
            project_color: info.project ? "green" : "red",
            status_color: info.status == "active" ? "green" : "red",
        }
        FlexDash.set('motus_recv', dash)
    }



    ////////////////////////
    // ENPI

    handle_enpi_status(status) {FlexDash.set('enpi/status', status || "??")}
    handle_enpi_sample_rate(sample_rate) {FlexDash.set('enpi/sample_rate', sample_rate || "??")}
    handle_enpi_sample_schedule(sample_schedule) {FlexDash.set('enpi/sample_schedule', sample_schedule || "??")}
    handle_enpi_aws_bucket_name(bucket_name) {FlexDash.set('enpi/aws/bucket_name', bucket_name || "??")}
    handle_enpi_aws_status(status) {FlexDash.set('enpi/aws/status', status || "??")}
    handle_enpi_upload_status(status) {FlexDash.set('enpi/upload/status', status || "??")}
    handle_enpi_upload_log(text) {FlexDash.set('enpi/upload/log', text || "??")}
    handle_enpi_upload_gotData(data) {FlexDash.set('enpi/upload/info', data?.[1] || {})}
    
    handle_enpi_version(text) {FlexDash.set('enpi/version', text || "??")}
    handle_enpi_update_log(text) {FlexDash.set('enpi/update/log', text || "??")}
    handle_enpi_provisioning_status(status) { FlexDash.set('enpi/provisioning/status', status || "??") }
    handle_enpi_provisioning_info(info) { FlexDash.set('enpi/provisioning/info', info || {}) }
    handle_dash_enpi_update() {Enpi.updateSoftware()}

    handle_dash_enpi_toggle(toggle) {Enpi.set('toggle',toggle)}
    handle_dash_enpi_sample_rate(sample_rate) {Enpi.set('sample_rate',sample_rate)}
    handle_dash_enpi_sample_schedule(sample_schedule) {Enpi.set('sample_schedule',sample_schedule)}
    handle_dash_enpi_provision(config) {Enpi.provision()}
    handle_dash_enpi_download(download) {Enpi.set('download',download)}
    handle_dash_enpi_force_upload(force) {Enpi.set('upload/force', force)}

    // Light level and air quality sensors
    handle_enpi_air_status(status) { FlexDash.set('enpi/air/status', status || "??") }
    handle_enpi_air_toggle(value) { FlexDash.set('enpi/air/toggle', value) }
    handle_enpi_light_status(status) { FlexDash.set('enpi/light/status', status || "??") }
    handle_enpi_light_toggle(value) { FlexDash.set('enpi/light/toggle', value) }

    handle_dash_enpi_air_toggle(toggle) { Enpi.set('air/toggle',toggle) }
    handle_dash_enpi_light_toggle(toggle) { Enpi.set('light/toggle',toggle) }

    
    // Lazy-init TimeSeries for an enpi sensor on first data; call ts_enpi_setup once.
    _enpiEnsureSensor(sensor) {
        if (this.enpi?.[sensor]?.ts) return
        if (!this.enpi) this.enpi = {}
        const schemas = {
            light: ['readings', 'light_level', 'temp'],
            air:   ['readings', 'temp', 'pressure', 'humidity', 'pm1', 'pm2_5', 'pm10'],
        }
        this.enpi[sensor] = {
            ts: Object.fromEntries(
                (schemas[sensor] || []).map(dtype => [dtype, new TimeSeries(ts_dir, `enpi-${sensor}-${dtype}`)])
            )
        }
        if (!this.enpi_setup_done) {
            this.enpi_setup_done = true
            this.ts_enpi_setup()
        }
    }

    // process data from air quality sensor
    handle_enpi_air_gotData(data) {
        // ts,temp,pressure,humidity,pm1,pm2.5,pm10, pc0.3, pc0.5,pc1,pc2.5,pc5,pc10
        try {
            const f = typeof data === "string" ? data.split(',') : data
            if (f.length != 13) return
            this._enpiEnsureSensor('air')
            const time = Math.round(parseFloat(f[0])*1000)
            const temp = parseFloat(f[1])
            const pressure = parseFloat(f[2]) / 10 // hpa to kpa
            const humidity = parseFloat(f[3])
            const pm1 = parseInt(f[4])
            const pm2_5 = parseInt(f[5])
            const pm10 = parseInt(f[6])
            if (this.enpi?.air?.ts?.readings) this.enpi.air.ts.readings.add(time, 1)
            if (this.enpi?.air?.ts?.temp) this.enpi.air.ts.temp.avg(time, temp)
            if (this.enpi?.air?.ts?.pressure) this.enpi.air.ts.pressure.avg(time, pressure)
            if (this.enpi?.air?.ts?.humidity) this.enpi.air.ts.humidity.avg(time, humidity)
            if (this.enpi?.air?.ts?.pm1) this.enpi.air.ts.pm1.avg(time, pm1)
            if (this.enpi?.air?.ts?.pm2_5) this.enpi.air.ts.pm2_5.avg(time, pm2_5)
            if (this.enpi?.air?.ts?.pm10) this.enpi.air.ts.pm10.avg(time, pm10)
        } catch (e) {
            console.warn("enpi: handle_enpi_air_gotData", e)
        }
    }
    // process data from light level sensor
    handle_enpi_light_gotData(data) {
        // ts,light_level,frequency,count,duration,temp
        try {
            const f = typeof data === "string" ? data.split(',') : data
            if (f.length != 6) return
            this._enpiEnsureSensor('light')
            const time = Math.round(parseFloat(f[0])*1000)
            const light_level = parseFloat(f[1])
            const temp = parseFloat(f[5])
            if (this.enpi?.light?.ts?.readings) this.enpi.light.ts.readings.add(time, 1)
            if (this.enpi?.light?.ts?.light_level) this.enpi.light.ts.light_level.avg(time, light_level)
            if (this.enpi?.light?.ts?.temp) this.enpi.light.ts.temp.avg(time, temp)
        } catch (e) {
            console.warn("handle_enpi_light_gotData", e)
        }
    }
    
    ts_enpi_setup() {
        setInterval(() => this.ts_enpi_save(), 60000)
        this.enpi_ts_ix = 2 // Day
        this.handle_dash_enpi_detection_range(TimeSeries.ranges[this.enpi_ts_ix])
    }

    handle_dash_enpi_detection_range(range) {
        try {
            const ix = TimeSeries.ranges.indexOf(range)
            if (ix < 0) { console.log("handle_dash_enpi_detection_range: bad range", range); return }
            this.enpi_ts_ix = ix
            this.ts_enpi_refresh()
            if (this.enpiRefreshInterval) clearInterval(this.enpiRefreshInterval)
            this.enpiRefreshInterval = setInterval(() => this.ts_enpi_refresh(), TimeSeries.intervals[ix])
        } catch (e) {
            console.warn("ts_enpi_refresh", e)
        }
    }

    ts_enpi_show( sensor, combinedData ) {
        
        // assemble the set of time-series to show
        const tsSet = []
        const labels = []

        for (const dtype in this.enpi?.[sensor]?.ts) {
            tsSet.push(this?.enpi?.[sensor]?.ts[dtype])
            labels.push(`${dtype}`)
        }
        if (tsSet.length == 0) {
            FlexDash.set(`enpi/${sensor}/detections`, { data: [], labels })
            return
        }
        const now = Date.now()
        const range = TimeSeries.ranges[this.enpi_ts_ix]
        //console.log("enpi: tsSet:", JSON.stringify(tsSet))
        const [times, values] = tsSet[0].get(range, now)
        //console.log("enpi: Got:", values)
        const interval = TimeSeries.intervals[this.enpi_ts_ix]
        console.log("enpi: this.enpi_ts_ix=", this.enpi_ts_ix)
        const fct = v => v// == null ? null : v * 3600*1000 / interval
        const data = times.map((t, i) => [Math.floor(t/1000), fct(values[i])])
        for (let i = 1; i < tsSet.length; i++) {
            const [times, values] = tsSet[i].get(range, now)
            if (times.length != data.length) throw new Error("tsShow: times length mismatch")
            if (Math.floor(times[0]/1000) != data[0][0]) throw new Error("tsShow: data start mismatch")
            for (let j=0; j<data.length; j++) data[j].push(fct(values[j]))
        }
        var pmData = times.map((t, i) => [Math.floor(t/1000)])
        var pmLabels = []
        if (!combinedData.temp)
            combinedData.temp = {
                data: times.map((t, i) => [Math.floor(t/1000)]),
                labels: [],
                title: `Temperature (${range})`
            }
        if (!combinedData.readings)
            combinedData.readings = {
                data: times.map((t, i) => [Math.floor(t/1000)]),
                labels: [],
                title: `Readings (${range})`
            }
        for (const dtype in this.enpi?.[sensor]?.ts) {
            const dtypeData = this?.enpi?.[sensor]?.ts[dtype].data[range]
            if (dtype.startsWith("pm")) {
                // Plot particulates together
                pmData.map( (d,i) => d.push(dtypeData[i]) )
                pmLabels.push(dtype)
            } else if (dtype.startsWith("temp") || dtype == "readings") {
                // Plot temperature together
                combinedData[dtype].data.map( (d,i) => d.push(dtypeData[i]) )
                combinedData[dtype].labels.push(sensor)
            } else {
                var dtypeTimedData = times.map((t, i) => [Math.floor(t/1000), fct(dtypeData[i])])
                var dtypeLabels = [dtype]
                var dtypeTitle = dtype + " (" + range + ")"
                FlexDash.set(`enpi/${sensor}/${dtype}`, { data: dtypeTimedData, labels: dtypeLabels, title: dtypeTitle})
            }
        }
        if (pmLabels.length > 0) 
            FlexDash.set(`enpi/${sensor}/pm`, { data: pmData, labels: pmLabels, title: `Particulates (${range})`})
        
        if (combinedData.temp.labels.length > 0) 
            FlexDash.set(`enpi/temp`, combinedData.temp)
        if (combinedData.temp.labels.length > 0) 
            FlexDash.set(`enpi/readings`, combinedData.readings)
        


        const title = sensor + " (" + range + ")" // can't set dynamic title :-(
        FlexDash.set(`enpi/${sensor}/detections`, { data, labels, title })
        // console.log(`enpi: ts_enpi_show: ${sensor} ${now} ${data.length} points, labels=${labels}`)
        // console.log('enpi: ',JSON.stringify(data))
        return combinedData
    }

    // save all the environmental sensor time-series to file
    ts_enpi_save() {
        try {
            for (const sensor in this.enpi) {
                const ts = this.enpi[sensor]?.ts
                for (const dtype in ts) {
                    ts[dtype].save() // only does something if it's dirty
                }
            }
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    ts_enpi_refresh() {
        
        try {
            // catch up all the graphs
            const now = Date.now()
            var combinedData = {temp: false, readings: false}
            for (const sensor in this.enpi) {
                const ts = this.enpi?.[sensor]?.ts || {}
                for (const dtype in ts) {
                    const fill = dtype == "readings" ? 0 : null
                    ts[dtype].append(now, fill, undefined)
                }
                combinedData = this.ts_enpi_show(sensor, combinedData)
            }
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }






    // ===== Pulses and tag time-series

    // generate a filename for a device's time-series
    tsFilename(dev) {
        let prefix
        switch (dev.attr.radio) {
        case "CTT/Cornell": prefix = "ctt"; break
        case "DigiBabel": prefix = "ctt"; break
        case "NanoBabel": prefix = "lotek"; break
        case "VAH": prefix = "lotek"; break
        case "GNU": prefix = "lotek"; break
        default: return null
        }
        return `${prefix}-${dev.attr.port}`
    }

    // device got added, init the time-series for it
    tsAddDevice(dev) {
        const port = dev.attr.port
        if (dev.attr.radio == "CTTBlu") {
            this.ts[port] = {
                tags: new TimeSeries(ts_dir, "blu-tags-"+dev.attr.port),
                unique_tags: new TimeSeries(ts_dir, "blu-unique_tags-"+dev.attr.port),
            }
        } else if (dev.attr.type == "CTT/CornellRcvr" || dev.attr.radio == "DigiBabel") {
            // CTT 434 devices only produce tag detections
            this.ts[port] = {
                tags: new TimeSeries(ts_dir, "ctt-tags-"+dev.attr.port),
                unique_tags: new TimeSeries(ts_dir, "ctt-unique_tags-"+dev.attr.port),
            }
        } else if (dev.attr.type == "funcubeProPlus" || dev.attr.type == "funcubePro" || dev.attr.type == "rtlsdr" || dev.attr.type == "airspy" || dev.attr.type == "airspyhf" || dev.attr.type == "NanoBabel") {
            // Lotek devices produce tag detections, pulses and noise figures
            this.ts[port] = {
                tags: new TimeSeries(ts_dir, "lotek-tags-"+dev.attr.port),
                pulses: new TimeSeries(ts_dir, "lotek-pulses-"+dev.attr.port),
                noise: new TimeSeries(ts_dir, "lotek-noise-"+dev.attr.port),
                snr: new TimeSeries(ts_dir, "lotek-snr-"+dev.attr.port),
                rate: new TimeSeries(ts_dir, "lotek-rate-"+dev.attr.port),
                unique_tags: new TimeSeries(ts_dir, "lotek-unique_tags-"+dev.attr.port),
            }
        }
        this.portMeta[port] = { type: dev.attr.type || '' }
        console.log("tsAddDevice", dev.attr.port, port)
    }

    tsRemoveDevice(dev) {
        if (!this.ts[dev.attr.port]) return
        for (const ts of Object.values(this.ts[dev.attr.port])) ts.close()
        delete this.ts[dev.attr.port]
    }

    // process a tag detection from a device
    tsGotTag(tag) {
        // T3,1681004846.412,0FE36400,-96,v2
        // L6,1681004878.702,TestTags#1.1@166.38:25.1,3.809,0.011,-25.5,1.18,-54.4,1,3,0.0005,4.96e-05,166.38
        try {
            const f = tag.split(',')
            if (f.length < 2) return
            const mm = f[0].match(/^([A-z])(\d+)/)
            if (!mm) return
            const port = mm[2]
            const time = Math.round(parseFloat(f[1])*1000)
            const tagId = f[2] || ''
            if (this.ts[port]?.tags) this.ts[port].tags.add(time, 1)
            // track unique tag IDs per port per time-series interval for the unique_tags plot
            if (this.ts[port]?.unique_tags && tagId) {
                if (!this.uniqueTagBuckets[port]) this.uniqueTagBuckets[port] = []
                const rangeValues = TimeSeries.ranges.map((_, i) => {
                    const bucket = Math.floor(time / TimeSeries.intervals[i])
                    if (!this.uniqueTagBuckets[port][i] || this.uniqueTagBuckets[port][i].bucket !== bucket) {
                        this.uniqueTagBuckets[port][i] = { bucket, tags: new Set() }
                    }
                    this.uniqueTagBuckets[port][i].tags.add(tagId)
                    return this.uniqueTagBuckets[port][i].tags.size
                })
                this.ts[port].unique_tags.max_ranges(time, rangeValues)
            }
            // buffer raw detections for the tally table
            if (tagId) this.tagBuffer.push({time, port, tagId})
            // we already record noise and snr for the pulses, so don't do it again
            // if (this.ts[port]?.noise && f.length >= 8) {
            //     const noise = parseFloat(f[7])
            //     this.ts[port].noise.avg(time, noise)
            // }
            // if (this.ts[port]?.snr && f.length >= 8) {
            //     const snr = parseFloat(f[5]) - parseFloat(f[7])
            //     this.ts[port].snr.avg(time, snr)
            // }
        } catch (e) {
            console.warn("tsGotTag", e)
        }
    }

    // process a pulse from a lotek radio
    tsGotPulse(info) {
        // p6,1681004979.0929,3.785,-29.66,-54.81,25.6
        // port, ts, dfreq, sig, noise, snr
        try {
            const f = info.split(',')
            if (f.length < 6) return
            const mm = f[0].match(/^p(\d+)/)
            if (!mm) return
            const port = mm[1]
            const time = Math.round(parseFloat(f[1])*1000)
            const noise = parseFloat(f[4])
            const snr = parseFloat(f[5])
            if (this.ts[port]?.pulses) this.ts[port].pulses.add(time, 1)
            if (this.ts[port]?.noise) this.ts[port].noise.avg(time, noise)
            if (this.ts[port]?.snr) this.ts[port].snr.avg(time, snr)
        } catch (e) {
            console.warn("tsGotPulse", e)
        }
    }

    tsGotRate(port, now, rate) {
        try {
            const time = Math.round(now)
            port = port.replace(/^[a-z]/, '');
            // console.log(`tsGotRate: ${port} ${time} ${rate} ${Object.keys(this.ts).join(",")}`)
            if (this.ts[port]?.rate) this.ts[port].rate.avg(time, rate)
            if (this.ts[port]?.rate) {
                const foo = this.ts[port].rate
                // console.log("tsGotRate", foo)
            }
        } catch (e) {
            console.warn("tsGotRate", e)
        }
    }

    // update a graph, what: lotek-tags, lotek-pulses, lotek-noise, ctt-tags
    tsShow(what) {
        const [prefix, series] = what.split('-')
        // assemble the set of time-series to show
        const tsSet = []
        const labels = []
        for (const port in this.ts) {
            if (series in this.ts[port] && this.ts[port][series].name.startsWith(prefix)) {
                tsSet.push(this.ts[port][series])
                labels.push(`port ${port}`)
            }
        }
        //console.log(`tsShow: ${what} ${tsSet.length} devices:`, tsSet.length)
        // get the data together
        if (tsSet.length == 0) {
            FlexDash.set(`detections/${series}`, { data: [], labels })
            return
        }
        const now = Date.now()
        const range = TimeSeries.ranges[this.ts_ix]
        const [times, values] = tsSet[0].get(range, now)
        //console.log("Got:", values)
        const interval = TimeSeries.intervals[this.ts_ix]
        const fct = ['noise','snr','rate','unique_tags'].includes(series)
            ? v => v
            : v => v == null ? null : v * 3600*1000 / interval
        const data = times.map((t, i) => [Math.floor(t/1000), fct(values[i])])
        for (let i = 1; i < tsSet.length; i++) {
            const [times, values] = tsSet[i].get(range, now)
            if (times.length != data.length) throw new Error("tsShow: times length mismatch")
            if (Math.floor(times[0]/1000) != data[0][0]) throw new Error("tsShow: data start mismatch")
            for (let j=0; j<data.length; j++) data[j].push(fct(values[j]))
        }
        const title = what.replace('-',' ') + " (" + range + ")" // can't set dynamic title :-(
        FlexDash.set(`detections/${what}`, { data, labels, title })
        //console.log(`tsShow: ${what} ${now} ${data.length} points, labels=${labels}`)
        //onsole.log(data)
    }

    // generate some random data, useful for testing only
    tsGenRandom() {
        const now = Date.now()
        console.log("tsGenRandom", Object.keys(this.ts))
        for (const port in this.ts) {
            const ts = this.ts[port]
            if (ts.pulses) {
                this.tsGotTag(`L${port},${now/1000},tag,0,0,0,0,${-50-Math.random()*10},0,0,0,0,166.38`)
                this.tsShow('lotek-tags')
                this.tsGotPulse(`p${port},${now/1000},0,0,${-50-Math.random()*10}`)
                this.tsShow('lotek-pulses')
                this.tsShow('lotek-noise')
                this.tsShow('lotek-snr')
                this.tsShow('lotek-rate')
            } else {
                this.tsGotTag(`T${port},${now/1000},12345678,0,1`)
                this.tsShow('ctt-tags')
            }
        }
    }

    // refresh the currently shown graphs
    tsRefresh() {
        try {
            // catch up all the graphs
            const now = Date.now()
            for (const port in this.ts) {
                const ts = this.ts[port]
                for (const series in ts) {
                    const fill = ['noise','snr','rate'].includes(series) ? null : 0
                    ts[series].append(now, fill, undefined)
                }
            }
            // trim tag buffer to max range window
            const maxAge = TimeSeries.limits[TimeSeries.limits.length-1] * TimeSeries.intervals[TimeSeries.intervals.length-1]
            const cutoff = Date.now() - maxAge
            const trimIdx = this.tagBuffer.findIndex(e => e.time >= cutoff)
            if (trimIdx > 0) this.tagBuffer.splice(0, trimIdx)

            // display
            for (const what of ['lotek-tags', 'lotek-pulses', 'lotek-noise', 'lotek-snr',
                    'lotek-rate', 'ctt-tags', 'lotek-unique_tags', 'ctt-unique_tags']) {
                this.tsShow(what)
            }
            this.tsTallyShow()
            this.sysmonShow()
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    // save all the time-series to file
    tsSave() {
        try {
            for (const port in this.ts) {
                const ts = this.ts[port]
                for (const series in ts) {
                    ts[series].save() // only does something if it's dirty
                }
            }
            for (const key in this.ts_sysmon) {
                this.ts_sysmon[key].save()
            }
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    // the user clicked a range button, switch the range for the charts
    handle_dash_detection_range(range) {
        try {
            const ix = TimeSeries.ranges.indexOf(range)
            if (ix < 0) { console.log("handle_dash_detection_range: bad range", range); return }

            let intv = TimeSeries.intervals[ix]/1000 // in seconds
            if (intv < 120) intv += "s"
            else if (intv < 7200) intv = Math.round(intv/60) + "m"
            else if (intv < 2*86400) intv = Math.round(intv/3600) + "h"
            else intv = Math.round(intv/86400) + "d"
            FlexDash.set("detections/interval", intv)

            this.ts_ix = ix
            this.tsRefresh()

            if (this.tsRefreshInterval) clearInterval(this.tsRefreshInterval)
            this.tsRefreshInterval = setInterval(() => this.tsRefresh(), TimeSeries.intervals[ix])
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    // compute tag-detection tally for the current range and push to FlexDash
    tsTallyShow() {
        try {
            const ix = this.ts_ix
            const window = TimeSeries.limits[ix] * TimeSeries.intervals[ix]
            const cutoff = Date.now() - window

            const typeCode = {
                'funcubeProPlus': 'FCD', 'funcubePro': 'FCD',
                'rtlsdr': 'RTL', 'airspy': 'ASM', 'airspyhf': 'AHF',
                'CTT/CornellRcvr': 'CTT', 'CTTBlu': 'BLU', 'DigiBabel': 'DB', 'NanoBabel': 'NB',
            }
            const ports = Object.keys(this.ts).sort((a, b) => parseInt(a) - parseInt(b))
            const columns = ['Tag ID', ...ports.map(port => {
                const type = this.portMeta[port]?.type || ''
                // match on prefix in case type was later refined (e.g. "rtlsdr/R820T2")
                const code = typeCode[type] || Object.entries(typeCode).find(([k]) => type.startsWith(k))?.[1] || ''
                return code ? `p${port} (${code})` : `p${port}`
            })]

            const entries = this.tagBuffer.filter(e => e.time >= cutoff)
            const tallyMap = {}
            for (const {port, tagId} of entries) {
                if (!tallyMap[tagId]) tallyMap[tagId] = {}
                tallyMap[tagId][port] = (tallyMap[tagId][port] || 0) + 1
            }

            const data = Object.entries(tallyMap)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([tagId, portCounts]) => [tagId, ...ports.map(p => portCounts[p] || 0)])

            FlexDash.set('detections/tally/data', data)
            FlexDash.set('detections/tally/columns', columns)
        } catch(e) {
            console.warn("tsTallyShow", e)
        }
    }

    // ===== Deployment configuration

    setDeployment() {
        // let data = Object.fromEntries(
        //     Object.entries(Deployment.data).map(e => 
        //         [ e[0].replace(/_/g,' '),
        //           e[0].includes('password') ? "********" : e[1]]
        // ))
        // delete data['module options']
        // let fields = ['short label', 'memo', 'upload username', 'upload password']
        FlexDash.set('deployment', {
            fields: ["memo"],
            // fields: ["label","memo"],
            data: { label: Acquisition.label, memo: Acquisition.memom, agc: Acquisition.agc?"on":"off" },
        })
        RTLSDR.enableAGC = !!Acquisition.agc
    }

    handle_dash_deployment_update(update) {
        console.log("handle_dash_deployment_update", update)
        Acquisition.update(Object.fromEntries(
            Object.entries(update).map(e => [e[0].replace(/ /g,'_'), e[1]])))
        this.setDeployment()
        // FlexDash.set('motus_login', `checking...`)
        // this.matron.emit("motus-creds")
    }

    handle_dash_enable_agc(value) {
        const enabled = value == 'on'
        RTLSDR.enableAGC = enabled
        Acquisition.update({ agc: enabled})
        this.setDeployment()
    }

    handle_dash_lotek_freq_change() {
        // update the acquisition settings
        let ix = LotekFreqs.indexOf(Acquisition.lotek_freq)
        ix = (ix+1) % LotekFreqs.length
        const f = LotekFreqs[ix]
        Acquisition.update({lotek_freq: f})
        // restart the radios and tag finder
        this.matron.emit("lotekFreqChg", f)
        HubMan.resetDevices()
    }

    setDashCreds(creds, message) {
        let data = Object.fromEntries(
            Object.entries(creds).map(e => [ e[0].replace(/_/g,' '), e[1]])
        )
        let fields = ['current password', 'new password', 'confirm new password']
        if (message) {
            console.log(`setDashCreds: ${message}`)
            data['message'] = message
            fields.unshift('message')
        }
        FlexDash.set('system_creds', { fields, data })
    }

    handle_dash_creds_update(update) {
        if (!(update['current password'] && update['new password'] && update['confirm new password'])) return
        let cp = update['current password'], np = update['new password']
        if (np != update['confirm new password']) {
            update['confirm new password'] = ""
            this.setDashCreds(update, "new passwords don't match")
            return
        }
        if (np.length < 8 || np.length > 32) {
            this.setDashCreds(update, "password must be 8 to 32 characters long")
            return
        }
        if (top100k.includes(np)) {
            this.setDashCreds(update, "please choose a less common password :-)")
            return
        }
        //Pam.authenticate(Machine.username, cp, (err) => {
        FlexDash.py_auth(Machine.username, cp, (err) => {
            if (err) {
                update['current password'] = ""
                this.setDashCreds(update, "incorrect current password")
            } else {
                // hash the pwd for the hotspot, uses the SSID as salt!
                const hpw = crypto.pbkdf2Sync(np, Machine.machineID, 4096, 256 / 8, "sha1").toString("hex")
                try {
                    CP.execFileSync("/usr/sbin/chpasswd", { input: `${Machine.username}:${np}\n` })
                    CP.execFileSync(wifi_hotspot, ["mode", "WPA-PSK", hpw])
                } catch(e) {
                    console.log("creds_update error", e)
                    return
                }
                this.setDashCreds({ current_password: "", new_password: "", confirm_new_password: ""},
                    "password updated")
            }
        }, {serviceName: 'login', remoteHost: 'localhost'})
    }

    // ===== Tag/Pulse detections for the last 5 minutes

    // shift/roll detection arrays by one element every 10 seconds
    detectionShifter() {
        this.detections.ctt.shift()
        this.detections.ctt.push(0)
        this.detections.blu.shift()
        this.detections.blu.push(0)
        this.detections.lotek.shift()
        this.detections.lotek.push(0)
        FlexDash.set('detections_5min', this.detections)
    }

    detectionLogPush(data) {
        this.detection_log.push(data)
        let dll = this.detection_log.length
        if (dll > 100) this.detection_log.splice(0, dll-100)
        FlexDash.set("detection_log", this.detection_log.join("\n"))
    }

    fmtTagDetection(line) {
        const ll = line.trim().split(',')
        if (line[0] == 'L') {
            // Lotek tag: port,ts,fullID,freq,freq.sd,sig,sig.sd,noise,run.id,pos.in.run,slop,burst.slop,ant.freq
            const name = ll[2].replace(/@.*/, '')
            const ts = (new Date(parseFloat(ll[1])*1000)).toISOString().replace(/.*T/, '').replace(/\..+/, '')
            const snr = (parseFloat(ll[5]) - parseFloat(ll[7])).toFixed(1)
            return `TAG ${ll[0]} ${ts}: ${ll[2]} ${ll[3]}kHz snr:${snr}dB (${ll[5]}/${ll[7]}dB)`
        } else if (line[0] == 'T' || line[0] == 'n') {
            // CTT tag:
            return `TAG ${line}`
        } else {
            return line
        }
    }

    handle_gotTag(tag) {
        if (!tag.match(/^[A-Za-z][0-9]/)) return
        if (tag.startsWith("T")) this.detections.ctt[this.detections.ctt.length-1]++
        FlexDash.set('detections_5min', this.detections)
        this.detectionLogPush(this.fmtTagDetection(tag))
        if (!tag.startsWith("n")) this.tsGotTag(tag.trim())
        // direction finding
        if (this.df_enable && this.df_tags) {
            let tt = tag.trim().split(",")
            if (tt.length < 4) return
            let name = tt[2].replace(/.*#([^@]+)@.*/,'$1') // lotek mess
            let signal = tt.length > 7 ? (parseFloat(tt[5]) - parseFloat(tt[7])).toFixed(1) + "dB"
                                       : tt[3] + "dBm"
            if (name == this.df_tags.tag1 || name == this.df_tags.tag2 || this.df_tags.tag1 == "*") {
                this.dfLogPush(tt[0], name, signal)
            }
        }
    }

    handle_gotBurst(burst) {
        // { text, info, meanFreq, sdFreq, meanSig, sdSig, meanNoise, meanSnr }
        // info: [ s0.port, s0.ts/1000, this.tagid, ...intv, ...tags[this.tagid] ]
        const bf = Acquisition.burstfinder
        if (burst.src == 'BF' && bf.method != 'burstfinder' && !bf.both_ui) return

        this.tsGotTag(`L${burst.info[0]},${burst.info[1]},${burst.info[2]}`)

        const ts = (new Date(burst.info[1]*1000)).toISOString().replace(/.*T/, '').replace(/\..*/, '')
        const meanFreq = parseFloat(burst.meanFreq).toFixed(3)
        const sdFreq = parseFloat(burst.sdFreq).toFixed(3)
        const minSnr = parseFloat(burst.minSnr).toFixed(1)
        this.detectionLogPush(
            `BUR B${burst.info[0]} ${ts}: #${burst.info[2]} ${meanFreq}kHz±${sdFreq} snr:${minSnr}dB src=${burst.src}`
        )
    }

    handle_vahData(line) {
        //console.log(`vahData: ${data.toString().replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`)
        if (line.startsWith("p")) {
            this.detections.lotek[this.detections.lotek.length-1]++
            if (!Acquisition.burstfinder.filter_ui) {
                // convert to something more readable
                const ll = line.trim().split(',')
                const port = parseInt(ll[0].slice(1))   // "p12" -> 12, "p2" -> 2
                const last_ts = this.pulse_ts[port] || 0
                const this_ts = parseFloat(ll[1])*1000
                const delta_ms = this_ts - last_ts < 120_000 ? "Δ"+(this_ts-last_ts).toFixed(1)+"ms" : ""
                this.pulse_ts[port] = this_ts
                const ts = (new Date(this_ts)).toISOString().replace(/.*T/, '').replace(/\..*/, '')
                const snr = parseFloat(ll[5]).toFixed(1)
                this.detectionLogPush(
                    `PLS ${ll[0]} ${ts}: ${ll[2]}kHz snr:${snr}dB ` +
                    `(${parseFloat(ll[3]).toFixed(1)}/${parseFloat(ll[4]).toFixed(1)}dB) ${delta_ms}`
                )
            }
            this.tsGotPulse(line.trim())
        } else if (line.startsWith("F")) {
            // broadband-interference flood interval: F<port>,<start_ts>,<end_ts>,<n_dropped>
            const ff = line.trim().split(',')
            const port = parseInt(ff[0].slice(1))
            const start_ts = parseFloat(ff[1]) * 1000
            const end_ts   = parseFloat(ff[2]) * 1000
            const dropped  = parseInt(ff[3]) || 0
            const fmt = t => (new Date(t)).toISOString().replace(/.*T/, '').replace(/\..*/, '')
            const dur = ((end_ts - start_ts) / 1000).toFixed(1)
            this.detectionLogPush(
                `FLOOD F${port} ${fmt(start_ts)}-${fmt(end_ts)}: ` +
                `broadband interference, ${dur}s, ${dropped} pulses dropped`
            )
        }
        FlexDash.set('detections_5min', this.detections)
    }

    handle_grhData(line) {
        this.handle_vahData(line);
    }

    handle_vahRate(port, now, rate) { this.tsGotRate(port, now, rate)}

    // capture VAH number of frames (samples) received for reporting via this.monitoring
    handle_vahFrames(port, now, frames) {
        port = port.replace(/^[a-z]/, '');
        FlexDash.set(`samples/${port}/frames`, frames)
        FlexDash.set(`samples/${port}/at`, now)
    }

    // handle tag database upload
    handle_dash_upload_tagdb(phase, info, resp) {
        if (phase === 'begin' && resp) {
            resp(info.size > 0 && info.size < 10*1024*1024 && TAGDBFILE)
        } else if (phase === 'done') {
            console.log("Tag DB upload done:", info)
            this.matron.emit("tagDBChg")
        }
    }

    // ===== Direction finding

    handle_dash_df_tags(tags) {
        if (typeof tags === 'object' && 'tag1' in tags && 'tag2' in tags) {
            this.df_tags = tags
            FlexDash.set("df_tags", tags)
            console.log("DF tags: " + JSON.stringify(tags))
        }
    }

    handle_dash_df_enable(en) {
        this.df_enable = en == true || en == "ON"
        FlexDash.set('df_enable', this.df_enable ? "ON" : "OFF")
        console.log("DF " + (this.df_enable ? "enabled" : "disabled"))
    }

    dfLogPush(port, name, signal) {
        const ts = new Date().toISOString().replace(/.*T/, '').replace(/\..+/, '')
        this.df_log.push(port + " " + ts + " " + name + " " + signal)
        let dfl = this.df_log.length
        // keep a fixed number of lines
        if (dfl > 10) this.df_log.splice(0, dfl-10)
        //console.log("df log: " + this.df_log.join(" | "))
        FlexDash.set("df_log", this.df_log.join("\n"))
    }

    // ===== /data file enumeration, download, (and upload?)

    // updateDetectionStats transforms the stats as they come from DataFiles into the format
    // required by the TimePLot widget of FlexDash, i.e. uPlot.
    // uPlot wants an array indexed by time, with each element being an array of values, the first
    // value being the X coordinate, and the rest being the series.
    updateDetectionStats(daily, hourly) {
        // get series names
        let series = Object.values(daily).reduce((series, day) => {
            Object.keys(day).forEach(d => series.add(d))
            return series
        }, new Set())
        series = Array.from(series.values()).sort()
        console.log(`updateDetectionStats: series=${series}`)

        // pivot daily stats
        const secs_per_day = 24*3600
        let today = Math.trunc(Date.now()/1000/secs_per_day)*secs_per_day
        let daily_data = Array(100)
        for (let i = 0; i < 100; i++) {
            const day = today - (99-i)*secs_per_day
            daily_data[i] = [day, ...series.map(s =>
                day in daily && s in daily[day]? daily[day][s] : null)]
        }
        FlexDash.set("detection_series", series.map(s => s=='all' ? 'lotek' : s))
        FlexDash.set("detections_daily", daily_data)

        // pivot hourly stats
        const secs_per_hour = 3600
        let curhour = Math.trunc(Date.now()/1000/secs_per_hour)*secs_per_hour
        let hourly_data = Array(100)
        for (let i = 0; i < 100; i++) {
            const hour = curhour - (99-i)*secs_per_hour
            hourly_data[i] = [hour, ...series.map(s =>
                hour in hourly && s in hourly[hour]? hourly[hour][s] : null)]
        }
        FlexDash.set("detections_hourly", hourly_data)
    }

    // user pressed a download button, we need to turn-around and tell the dashboard to
    // actually perform the download (yes, it's a bit convoluted)
    // what: new/all/last
    handle_dash_download(what, socket) {
        FlexDash.download(socket, `/data-download/${what}`, 'foo.zip')
    }
    // To download through websocket see: https://stackoverflow.com/questions/29066117

    // Handle GET request to download data files
    // See https://stackoverflow.com/a/61313182/3807231
    async data_download(req, resp) {
        console.log("data_download:", req.params.what)
        // combine same-boot text files into fewer, larger ones before building the archive list,
        // so there's less to parse through once it's downloaded and unpacked. Express 4 doesn't
        // catch async route handler rejections, so guard this explicitly.
        try {
            await DataFiles.repackForDownload(req.params.what)
        } catch (e) {
            console.log(`data_download: repack failed: ${e}`)
        }
        let files = DataFiles.downloadList(req.params.what)
        if (!files) {
            resp.writeHead(200, {'Content-Type': 'text/plain'})
            resp.send()
            return
        }
        // download date, will be recorded in "database"
        let now = new Date()
        let filename = Machine.machineID + "-" + now.toISOString() + ".zip"
        // tell the browser that we're sending a zip file
        resp.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-disposition': 'attachment; filename=' + filename
        })
        // stream zip archive into response
        console.log(`Streaming ZIP with ${files.length} files`)
        let archive = AR('zip', { zlib: { level: 1 } }) // we're putting .gz files in...
        archive.pipe(resp)
        files.forEach(f => archive.file(f, { name: Path.basename(f) }))
        archive.finalize()
        // update the database with the date of the download
        let date = Math.trunc(now.getTime()/1000)
        DataFiles.updateUpDownDate('downloaded', files, date)
    }

    handle_dash_upload(_, socket) {
        MotusUp.uploadSoon(true) // force upload asap
    }

    // ===== Software updates

    // toggle to enable/disable all the software update functionality
    handle_dash_software_enable(value) {
        FlexDash.set('software/enable', value)
        if (!value) FlexDash.set('software/enable_upgrade', false)
    }
    // toggle to enable/disable all the software update functionality
    handle_dash_allow_shutdown(value) {
        FlexDash.set('software/enable_shutdown', value)
        this.allow_poweroff = value
    }

    // show and toggle release train
    releasemap = {stable:'bookworm',testing:'booktest',bookworm:'stable',booktest:'testing'}
    handle_dash_toggle_train(value) {
        FlexDash.set('software/train', value)
        if (['stable','testing'].includes(value)) {
            value = this.releasemap[value]
            Fs.readFile('/etc/apt/sources.list.d/sensorgnome.list', (err, data) => {
                if (err) {
                    console.log("Error reading sensorgnome.list:", err)
                    return
                }
                data = data.toString().replace(/(bookworm|booktest)/, value)
                Fs.writeFile('/etc/apt/sources.list.d/sensorgnome.list', data, (err) => {
                    if (err) {
                        console.log("Error writing sensorgnome.list:", err)
                        return
                    } else {
                        console.log("Changed release train to", value)
                    }
                })
            })
        }
    }
    setDashTrain() {
        Fs.readFile('/etc/apt/sources.list.d/sensorgnome.list', (err, data) => {
            if (err) {
                console.log("Error reading sensorgnome.list:", err)
                return
            }
            let train = data.toString().match(/(bookworm|booktest)/)
            if (train) {
                FlexDash.set('software/train', this.releasemap[train[1]])
            }
        })
    }

    handle_dash_software_restart() { Upgrader.restart() }
    handle_dash_software_reboot() { Upgrader.reboot() }
    handle_dash_software_shutdown() {
        if (this.allow_poweroff) Upgrader.shutdown()
    }
    handle_dash_software_check() { Upgrader.check() }
    handle_dash_software_upgrade(what) { Upgrader.upgrade(what) }

    // download logs button (what must be "all" for now)
    handle_dash_download_logs(what, socket) {
        FlexDash.download(socket, `/logs-download/${what}`, 'logs.zip')
    }

    // Handle GET request to download log files
    // See https://stackoverflow.com/a/61313182/3807231
    logs_download(req, resp) {
        console.log("log_download:", req.params.what)
        let files = Fs.readdirSync("/var/log", 'utf8')
        files = files.
            filter(f => f.startsWith("sg-control")||f.startsWith("syslog")).
            map(f=>'/var/log/'+f)
        //files.push("/var/log/syslog")
        let now = new Date()
        let filename = Machine.machineID + "-" + now.toISOString() + "-logs.zip"
        // tell the browser that we're sending a zip file
        resp.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-disposition': 'attachment; filename=' + filename
        })
        // stream zip archive into response
        console.log(`Streaming ZIP with ${files.length} log files`)
        let archive = AR('zip', { zlib: { level: 1 } }) // we're putting .gz files in...
        archive.pipe(resp)
        files.forEach(f => archive.file(f, { name: Path.basename(f) }))
        archive.finalize()
    }

    // ===== Remote management

    setRemoteManagement(new_config) {
        Fs.readFile(remote_access, (err, data) => {
            if (err) {
                console.log(`Error reading ${remote_access}: ${err}`)
                return
            }
            try {
                const config = JSON.parse(data)
                if (new_config) {
                    Object.assign(config, new_config)
                    Fs.writeFile(remote_access, JSON.stringify(config), (err) => {
                        if (err) console.log(`Error writing ${remote_access}: ${err}`)
                    })
                }
                FlexDash.set('remote/cmds', config.commands ? "enabled" : "disabled")
                config.webui = false // always show webui as disabled for now
                FlexDash.set("remote/webui", config.webui ? "enabled" : "disabled")
            } catch(e) {
                console.log(`Error parsing ${remote_access}: ${e}`)
            }
        })
    }

    handle_dash_remote_cmds(value) {
        const v = value === true || value == "enabled"
        this.setRemoteManagement({ commands: v })
    }
    handle_dash_remote_webui(value) {
        const v = value === true || value == "enabled"
        this.setRemoteManagement({ webui: v })
    }

    // ===== Sixfab UPS HAT information

    // get all the available info about the UPS HAT from a custom python script that queries the
    // sixfab power-api. This produces a bunch of json metrics which we just dump into flexdash.
    // It returns true if successful, false otherwise
    getUpsHatInfo() {
        return new Promise((resolve, reject) => {
            ChildProcess.execFile(SixfabUpsHat, (code, stdout, stderr) => {
                //console.log(`Exec "${cmd} ${args.join(" ")}" -> code=${code} stdout=${stdout} stderr=${stderr}`)
                if (code || stderr) reject(new Error(`${SixfabUpsHat} failed: ${stderr||code}`))
                try {
                    let data = JSON.parse(stdout)
                    FlexDash.set('ups_hat', data)
                    resolve(true)
                    // if the UPS HAT says that we should shut down, do it
                    if (data['shutdown']) {
                        console.log("UPS HAT says we should shut down")
                        MotusUp.uploadSoon(true) // force upload asap
                        // shut down before next HAT query
                        setTimeout(() => Upgrader.shutdown(), 50*1000)
                    }
                } catch (e) {
                    //console.log(`Got : ${stdout}`)
                    FlexDash.set('ups_hat', {input: {status:"error querying HAT"}, system:{}, battery:{}})
                    reject(new Error(`${SixfabUpsHat} failed: ${e}`))
                }
            })
        })
    }

    startUpsHatUpdater() {
        let ok = this.getUpsHatInfo()
        .then(() => {
            setInterval(() => this.getUpsHatInfo(), 60*1000)
        })
        .catch((e) => {
            console.log("Assuming no Sixfab UPS HAT:", e.message)
            FlexDash.set('ups_hat', {input: {status:"HAT not installed"}, system:{}, battery:{}})
        })
    }

    // ===== Network usage collected by vnStat

    updateNetUsage() {
        ChildProcess.execFile(vnstat, (code, stdout, stderr) => {
            //console.log(`Exec "${cmd} ${args.join(" ")}" -> code=${code} stdout=${stdout} stderr=${stderr}`)
            if (code || stderr) {
                console.log(`${vnstat} failed: ${stderr||code}`)
                return
            }
            try {
                // rows: [iface, when, rx, tx, total, predicted]
                const data = []
                let iface = '??'
                for (const line of stdout.split('\n')) {
                    const words = line.split(/  */)
                    if (words[0] == "") words.shift()
                    if (words.length == 1 && words[0].endsWith(':')) {
                        data.push(['','',words[0].slice(0,-1),'',''])
                    } else if (words.length == 0) {
                        // ignore
                    } else if (words[0].endsWith(':')) {
                        // ignore ("Not enough data available yet")
                    } else if (words[0] == 'rx') {
                        // ignore (header)
                    } else if (words[3] == '/') {
                        let row = [words.shift()]
                        while (words.length > 0) {
                            const w = words.shift()
                            if (w == '--') row.push('--')
                            else row.push(`${w} ${words.shift()}`)
                            if (words.length > 0 && words[0] == '/') words.shift()
                        }
                        data.push(row)
                    }
                }
                FlexDash.set('net_usage_data', data)
                FlexDash.set('net_usage_columns', ['when', 'rx', 'tx', 'total', 'predicted'])
            } catch (e) {
                //console.log(`Got : ${stdout}`)
                FlexDash.set('net_usage_data', {})
                console.log(`${vnstat} parsing failed:`, e)
            }
        })

        CellMan.getCellPriority().then(prio => FlexDash.set('cellular/priority', prio))
    }

    // ===== Return monitoring data in json format
    // This is in the dashboard module because most of the data is grabbed from the dashboard
    // state variables.
    monitoring() {
        return {
            radios: {
                counts: FlexDash.get('radios'),
                devices: FlexDash.get('devices'),
                samples: FlexDash.get('samples'),
                state: FlexDash.get('radio_state'),
            },
            detections: {
                series: FlexDash.get('detection_series'),
                daily: FlexDash.get('detections_daily'),
                hourly: FlexDash.get('detections_hourly'),
                tagdb: FlexDash.get('tagdb'),
            },
            gps: FlexDash.get('gps'),
            uploads: {
                result: FlexDash.get('motus_upload'),
                project_id: FlexDash.get('motus_recv/project_id'),
                deployment_status: FlexDash.get('motus_recv/status'),
            },
            files: {
                summary: FlexDash.get('data_file_summary'),
            },
            network: {
                wifi: FlexDash.get('net_wifi_state'),
                hotspot: FlexDash.get('net_hotspot_state'),
                cell: FlexDash.get('cellular/state'),
                inet: FlexDash.get('net_default_route'),
            },
            cell_info: FlexDash.get('cellular/info'),
        }
    }

}

module.exports = Dashboard
