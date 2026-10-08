/*
  matron.js: provide a global object through which all events are routed
  (event listeners are registered here, and events are emitted from here).
  This way, if an Event Emitter must be recreated (e.g. after its child
  process dies), listener registration is preserved.

*/

Matron = function() {
    this.devices = {};

    // callback closures
    this.this_devAdded = this.devAdded.bind(this);
    this.this_devRemoved = this.devRemoved.bind(this);
    this.this_VAHdied = this.VAHdied.bind(this);

    this.on("devAdded", this.this_devAdded);
    this.on("devRemoved", this.this_devRemoved);
    this.on("bad", function(msg) {console.log(msg + "\n");});
    this.on("VAHdied", this.this_VAHdied);
};

Util.inherits(Matron, Events.EventEmitter);

Matron.prototype.devAdded = function(dev) {
    console.log(`New device found: ${dev.path} --> ${JSON.stringify(dev.attr)}`);

    var devPlan = Acquisition.lookup(dev.attr.port, dev.attr.type);
    if (devPlan) {
        //console.log("Got plan " + JSON.stringify(devPlan));
        this.devices[dev.attr.port] = Sensor.getSensor(this, dev, devPlan);
    }

    // for CTT/CornellRcvr, we don't require or use a plan
    if (dev.attr.type == "CTT/CornellRcvr") {
        this.devices[dev.attr.port] = new CornellTagXCVR(this, dev, null);
    }
    
    // Receivers using the shared FTDI USB VID:PID (0403:6015) require protocol-level identification
    if (dev.attr.type == "DigiBabel") {
        this.devices[dev.attr.port] = new FTDIReceiverProbe(this, dev, null);
    }
};

Matron.prototype.devRemoved = function(dev) {
    console.log("Device removed: " + dev.path);
    if (this.devices[dev.attr.port]) {
        this.devices[dev.attr.port] = null;
    };
};

Matron.prototype.VAHdied = function() {
    // destroy device objects, since device server has died
    // TvE: this is actually done in hubman's VAHdied callback...
    // for (var i in this.devices) {
    //     if ('alsaDev' in this.devices[i].attr) {
    //         this.devices[i] = null;
    //     }
    // }
};

exports.Matron = Matron;
