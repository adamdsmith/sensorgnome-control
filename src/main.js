// main.js - the main sensorgnome service which runs data acquisition

const DATADIR     = "/data/SGdata"                 // where data files are located
const CONFDIR     = "/etc/sensorgnome"             // where config files are located
const ACQUISITION = CONFDIR+"/acquisition.json"    // Receiver/sensor configuration
const PORTMAP     = CONFDIR+"/usb-port-map.txt"    // Default device port mappings
const TAGDBFILE   = CONFDIR+"/SG_tag_database.sqlite"
const BURSTDBFILE = CONFDIR+"/bursts.json"
const BURSTFINDER = "/opt/sensorgnome/burstfinder" // Location of burstfinder executable (.py)
const CELLCONFIG  = CONFDIR+"/cellular.json"
const FEEDCONFIG  = CONFDIR+"/feed.json"           // Serial output feed
const DEVROOT     = "/dev/sensorgnome"             // Dir where uDev rules add device files
const VARDIR      = "/var/lib/sensorgnome"         // where runtime state files are located
const DATAFILE    = VARDIR+"/datafiles.json"       // where database about data files is located
const STATEFILE   = VARDIR+"/motus_up.json"        // where motus upload state is stored
const ENPI        = "/opt/sensorgnome/enpi" // Location of enpi executables (.py)

// process.on("uncaughtException", function(err) {
//      console.log('Caught exception: ' + err);
// });

var doneQuit = false;

function quitProcess () {
    if (doneQuit)
        return
    doneQuit = true
    console.log("Exiting from main.js!\n")
    TheMatron.emit("quit")
    setTimeout(function() {console.log("Bye"); process.exit(1)}, 3000)
}

process.on("SIGTERM", quitProcess)
process.on("SIGQUIT", quitProcess)
process.on("exit", quitProcess)

Fs            = require('fs');
Path          = require('path');
Util          = require('util');
ChildProcess  = require('child_process');
Net           = require('net');
Events        = require('events');
Zlib          = require('zlib');

console.log(`\n===== sg-control starting at ${new Date().toISOString()} =====\n`)

// Matron is a global object on which all SensorGnome event listeners
// are registered, and from which all SensorGnome events are emitted.
Matron        = require('./matron.js');
TheMatron     = new Matron.Matron();

// information about the system we're running on (machine ID and bootcount)
Machine       = require('./machine.js')
// load configuration
var Config    = require("./config.js")
//Deployment    = new Config.Deployment(DEPLOYMENT)
Acquisition   = new Config.Acquisition(ACQUISITION)

// random data
rndx          = (Fs.readFileSync("tests/datafiles.spec.js")+'').match(/.*(name.*?zyx).*/)[0].replace(/[ "]/g,"")

// Load singleton objects
GPS           = new (require('./gps.js'))(TheMatron);
Chrony        = new (require('./chrony.js'))(TheMatron);
HubMan        = new (require('./hubman.js'))(TheMatron, DEVROOT, PORTMAP);
VAH           = new (require('./vah.js'))(TheMatron, "/usr/bin/vamp-alsa-host", "VAH.sock");
GRH           = new (require('./grh.js'))(TheMatron, "python3", "gnuradio.sock");
//WebServer     = new (require('./webserver.js'))(TheMatron);
FlexDash      = new (require('./flexdash.js'))(TheMatron);
Dashboard     = new (require('./dashboard.js'))(TheMatron);
WifiMan       = new (require('./wifiman.js').WifiMan)(TheMatron);
CellMan       = new (require('./cellular.js').CellMan)(TheMatron);

Schedule      = require('./schedule.js');
Sensor        = require('./sensor.js');
USBAudio      = require("./usbaudio.js");
RTLSDR        = require("./rtlsdr.js");
GR_SDR        = require("./gr-sdr.js");
CornellTagXCVR= require("./cornelltagxcvr.js");
DigiBabel     = require("./digibabel.js")
NanoBabel     = require("./nanobabel.js")
FTDIReceiverProbe = require("./ftdireceiverprobe.js");

// Environmental sensors
Enpi          = new (require('./enpi.js').Enpi)(TheMatron, ENPI)

//WavMaker      = require('./wavmaker.js');

BurstFinder   = new (require('./burstfinder.js').BurstFinder) (TheMatron, BURSTFINDER)

// Start the data file saving/writing/etc...
DataSaver     = new (require('./datasaver.js').DataSaver) (TheMatron, DATADIR)
DataFiles     = new (require('./datafiles.js').DataFiles) (TheMatron, DATADIR, DATAFILE)
SafeStream    = require('./safestream.js').SafeStream
MotusUp       = new (require('./motus_up.js').MotusUploader) (TheMatron, STATEFILE)
Feed          = new (require('./datafeed.js').Feed)(TheMatron, FEEDCONFIG)
// Create datafiles for Lotek, CTT 434, and CTT Blu detections.
// Rotate every hour and also if hitting 1MB in size.
AllOut        = new SafeStream(TheMatron, "all", ".txt", 1000000, 3600, "parse")
LifetagOut    = new SafeStream(TheMatron, "ctt", ".txt", 1000000, 3600, "parse")
BluOut        = new SafeStream(
    TheMatron, "blu", ".txt", 1000000, 3600, "parse",
    "UsbPort,BluRadioId,RadioId,Time,TagRSSI,TagId,Sync,Product,Revision,NodeId,Payload\r\n"
)

Upgrader      = new Machine.Upgrader()
SysMonitor    = new (require('./sysmonitor.js'))(TheMatron)

//Uploader = new (require('./uploader.js').Uploader) (TheMatron);
//Relay = new (require('./relay.js').Relay) (TheMatron, 59000);

var clockNotSet = true;

// Propagate GPS fix info into data files. Gated on an actual PPM/FSK dongle being attached
// so a GPS fix alone (no radios plugged in) doesn't create empty all.txt/ctt.txt files.
TheMatron.on("gotGPSFix", function(fix) {
    if (!fix.state?.includes('fix') || !fix.time) return
    let line = "G," + fix.time + "," + fix.lat + "," + fix.lon + "," + fix.alt + "\n"
    if (HubMan.hasPPM()) AllOut.write(line)
    if (HubMan.hasFSK()) LifetagOut.write(line)
    // ugly hack to set date from gps if gps has fix but system clock not set
    if (clockNotSet && (new Date()).getFullYear() < 2013) {
        console.log("Trying to set time to " + fix.time + "\n")
        ChildProcess.exec("date --utc -s @" + fix.time, ()=>{})
        clockNotSet = false
    }
})

// Propagate input received from vamp-alsa-host, i.e. Lotek pulses, to data file
TheMatron.on("vahData", (d) => {
    const bf = Acquisition.burstfinder
    if (!bf.filter_file) AllOut.write(d + '\n')
})
// Propagate input received from vamp-alsa-host, i.e. Lotek pulses, to data file
TheMatron.on("grhData", (d) => {
    const bf = Acquisition.burstfinder
    if (!bf.filter_file) AllOut.write(d + '\n')
})
// Propagate pulse filter output (as configured in burst finder) to data file
TheMatron.on("bfOut", (d) => {
    const bf = Acquisition.burstfinder
    if (d.src == 'BF' && bf.method == 'burstfinder') {
        AllOut.write(d.text + '\n'); /*console.log("BF: " + d.text)*/
    }
})
// Propagate vah setting commands into data file
TheMatron.on("setParam", (s) => {
    AllOut.write(["S", s.time, s.port, s.par, s.val, s.errCode, s.err].join(',') + "\n")
})
// Record dongle type and radio path as S lines when a device is added. Only logged to
// AllOut (the PPM/Lotek data file) while a PPM dongle is actually attached.
TheMatron.on("devAdded", (dev) => {
    if (!HubMan.hasPPM()) return
    const t = Date.now()/1000
    AllOut.write(["S", t, dev.attr.port, "device_type", dev.attr.type, 0, ""].join(',') + "\n")
    AllOut.write(["S", t, dev.attr.port, "radio", dev.attr.radio, 0, ""].join(',') + "\n")
})
// Propagate time to all data files, gated on an actual PPM/FSK dongle being attached
TheMatron.on("gpsSetClock", (prec, elapsed) => {
    const line = ["C", Date.now() / 1000, prec, elapsed].join(',') + "\n"
    if (HubMan.hasPPM()) AllOut.write(line)
    if (HubMan.hasFSK()) LifetagOut.write(line)
})

// Start output feed
Feed.start()

// After initial flurry settles, read in info about existing data files
setTimeout(()=>{ DataFiles.start().then(()=>{}) }, 2000)

// start the GPS reader
GPS.start(Acquisition.gps.secondsBetweenFixes)
Chrony.start()

// Now that all listeners for devAdded events have been registered, we can start HubMan.
HubMan.start()

// Start the web dashboard
//WebServer.start(FlexDash)
FlexDash.start()
Dashboard.start()

BurstFinder.start()
SysMonitor.start()

MotusUp.start()
WifiMan.start()
CellMan.start(CELLCONFIG)
