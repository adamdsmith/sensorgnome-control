// ftdireceiverprobe.js — identify a connected 0403:6015 (FTDI FT230X) receiver
// is a DigiBabel (230400 baud) or NanoBabel (115200 baud) receiver.
//
// Both devices use the same USB VID:PID and product string and cannot be
// distinguished in udev.  This probe opens at 230400 baud, sends the DigiBabel
// DET_OFF command, and waits up to PROBE_TIMEOUT_MS for any byte matching the
// DigiBabel START_FLAG (0x3C).  A NanoBabel at 115200 baud will not respond,
// so a timeout means NanoBabel.
//
// Once identified the probe closes its port and creates the real device object,
// replacing itself in matron.devices[port].

const {SerialPort} = require('serialport')
const DigiBabel = require('./digibabel')
const NanoBabel = require('./nanobabel')

const PROBE_TIMEOUT_MS = 2500
const DB_START_FLAG    = 0x3C
const DB_POLY16        = 0x1021

// ---- minimal CRC-16 and frame builder needed to send the DET_OFF probe ----

function crc16Byte(byte, crc) {
  crc ^= (byte & 0xFF) << 8
  for (let i = 0; i < 8; i++) {
    crc = (crc & 0x8000) ? ((crc << 1) ^ DB_POLY16) & 0xFFFF : (crc << 1) & 0xFFFF
  }
  return crc
}

function calcCrc16(buf) {
  let crc = 0
  for (const b of buf) crc = crc16Byte(b, crc)
  // Lotek CRCs are byte-swapped
  return (((crc & 0xFF) << 8) | ((crc >> 8) & 0xFF)) & 0xFFFF
}

function buildDetOffFrame() {
  // DET_OFF: MSG=0x00, CMD=0x0D, OP=0x00, payload=[0x01]
  const payload = 0x01
  const core = Buffer.from([0x01, 0x00, 0x0D, 0x00, payload]) // [len, msg, cmd, op, payload]
  const crc = calcCrc16(core.slice(1))                        // CRC over [msg, cmd, op, payload]
  return Buffer.from([0x3C, ...core, (crc >> 8) & 0xFF, crc & 0xFF, 0x3E])
}

// ---------------------------------------------------------------------------

const DET_OFF_FRAME = buildDetOffFrame()

class FTDIReceiverProbe {
  constructor(matron, dev, options) {
    this.matron = matron
    this.dev = dev
    this.options = options ?? {}
    this.sp = null
    this.probeTimeout = null
    this.resolved = false

    this.matron.on("devRemoved", (dev) => this.devRemoved(dev))
    this.matron.emit("devState", dev.attr.port, "init")
    this.startProbe()
  }

  getPort() { return this.dev?.attr?.port ?? '?' }

  startProbe() {
    if (!this.dev) return
    const path = this.dev.path
    this.sp = new SerialPort({ path, baudRate: 230400, dataBits: 8, parity: 'none', stopBits: 1 })

    this.sp.on("open", () => {
      console.log(`FTDIReceiverProbe: probing ${path} (port ${this.getPort()}) for DigiBabel vs NanoBabel`)
      setTimeout(() => {
        if (!this.dev || !this.sp?.isOpen) return
        this.sp.write(DET_OFF_FRAME)
      }, 300)
      this.probeTimeout = setTimeout(() => this.resolve('NanoBabel'), PROBE_TIMEOUT_MS)
    })

    this.sp.on("data", data => {
      // Any 0x3C byte means a DigiBabel replied with a framed response
      if (!this.resolved && data.includes(DB_START_FLAG)) {
        this.resolve('DigiBabel')
      }
    })

    this.sp.on("error", err => {
      console.log(`LotekProbe error on ${path}: ${err.message}`)
      if (!this.resolved) this.resolve('NanoBabel')
    })

    this.sp.on("close", () => {
      if (!this.resolved) this.resolve('NanoBabel')
    })
  }

  resolve(type) {
    if (this.resolved) return
    this.resolved = true
    clearTimeout(this.probeTimeout)
    this.probeTimeout = null

    console.log(`FTDIReceiverProbe: port ${this.getPort()} identified as ${type}`)

    const create = () => {
      if (!this.dev) return
      const { matron, dev, options } = this
      if (type === 'DigiBabel') {
        matron.devices[dev.attr.port] = new DigiBabel(matron, dev, options)
      } else {
        dev.attr.type = 'NanoBabel'
        dev.attr.radio = 'NanoBabel'
        matron.emit('nanobabelIdentified', { port: dev.attr.port })
        matron.devices[dev.attr.port] = new NanoBabel(matron, dev, options)
      }
    }

    if (this.sp?.isOpen) {
      this.sp.close(() => setTimeout(create, 300))
    } else {
      setTimeout(create, 300)
    }
  }

  close() {
    clearTimeout(this.probeTimeout)
    if (this.sp?.isOpen) this.sp.close()
    this.sp = null
  }

  devRemoved(dev) {
    if (!this.dev || dev.path !== this.dev.path) return
    this.resolved = true  // prevent resolve() from firing after removal
    this.close()
    this.dev = null
  }
}

module.exports = FTDIReceiverProbe
