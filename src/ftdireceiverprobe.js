// ftdireceiverprobe.js — identify a connected 0403:6015 (FTDI FT230X) receiver
// as DigiBabel, CTT Blū, or NanoBabel.
//
// These receivers can enter SensorGnome through the same FTDI USB identity
// (VID=0403, PID=6015), so udev alone cannot distinguish them. Identification
// is deliberately protocol-level and ordered:
//
//   1. Preserve the existing DigiBabel probe unchanged.
//   2. If DigiBabel does not answer, explicitly power on CTT Blū with DTR low,
//      wait for boot, and issue a non-destructive VERSION request.
//   3. If neither protocol answers, retain the existing NanoBabel fallback.
//
// Once a receiver is positively identified, the probe closes its serial port.
// DigiBabel and NanoBabel are handed to their existing drivers. CTT Blū is
// positively identified here; its receiver driver is added separately.

const {SerialPort} = require('serialport')
const DigiBabel = require('./digibabel')
const NanoBabel = require('./nanobabel')
const BluBabel = require('./blubabel')

const DB_PROBE_TIMEOUT_MS  = 2500
const BLU_BOOT_DELAY_MS     = 1600
const BLU_PROBE_TIMEOUT_MS  = 1500
const DB_START_FLAG         = 0x3C
const DB_POLY16             = 0x1021
const BLU_VERSION_REQUEST   = '{"type":1,"channel":1,"data":{}}\r\n'

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
    this.phase = 'digibabel'
    this.textBuffer = ''

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
      console.log(`FTDIReceiverProbe: probing ${path} (port ${this.getPort()}) for DigiBabel`)
      setTimeout(() => {
        if (!this.dev || !this.sp?.isOpen || this.resolved) return
        this.sp.write(DET_OFF_FRAME)
      }, 300)
      this.probeTimeout = setTimeout(() => this.startBluProbe(), DB_PROBE_TIMEOUT_MS)
    })

    this.sp.on("data", data => {
      if (this.resolved) return

      // Preserve existing DigiBabel identification semantics.
      if (this.phase === 'digibabel') {
        if (data.includes(DB_START_FLAG)) this.resolve('DigiBabel')
        return
      }

      // CTT Blū replies with newline-delimited JSON.
      if (this.phase === 'cttblu') {
        this.textBuffer += data.toString('utf8')
        let newline
        while ((newline = this.textBuffer.indexOf('\n')) !== -1) {
          let line = this.textBuffer.slice(0, newline).trim()
          this.textBuffer = this.textBuffer.slice(newline + 1)
          if (!line) continue

          // Blū may emit a couple of non-JSON boot bytes before the VERSION
          // response (observed as 0x2c 0x00). Discard any prefix before the
          // first JSON object rather than letting it poison the whole line.
          const jsonStart = line.indexOf('{')
          if (jsonStart === -1) continue
          line = line.slice(jsonStart)

          try {
            const msg = JSON.parse(line)
            if (msg?.type === 1 && msg?.channel === 1 && msg?.data !== undefined) {
              this.resolve('CTTBlu')
              return
            }
          } catch (_) {
            // Ignore non-JSON / wrong-baud bytes while probing.
          }
        }
      }
    })

    this.sp.on("error", err => {
      console.log(`FTDIReceiverProbe error on ${path}: ${err.message}`)
      if (!this.resolved) this.resolve('NanoBabel')
    })

    this.sp.on("close", () => {
      if (!this.resolved) this.resolve('NanoBabel')
    })
  }

  startBluProbe() {
    if (this.resolved || !this.dev || !this.sp?.isOpen) return
    clearTimeout(this.probeTimeout)
    this.probeTimeout = null
    this.phase = 'cttblu'
    this.textBuffer = ''

    console.log(`FTDIReceiverProbe: no DigiBabel response on port ${this.getPort()}; probing for CTTBlu`)

    // CTT Blū power is controlled by DTR: false/low = powered on.
    this.sp.set({ dtr: false }, err => {
      if (err) {
        console.log(`FTDIReceiverProbe: failed to set DTR for CTTBlu probe on port ${this.getPort()}: ${err.message}`)
        this.resolve('NanoBabel')
        return
      }

      setTimeout(() => {
        if (this.resolved || !this.dev || !this.sp?.isOpen) return
        this.sp.write(BLU_VERSION_REQUEST)
        this.probeTimeout = setTimeout(() => this.resolve('NanoBabel'), BLU_PROBE_TIMEOUT_MS)
      }, BLU_BOOT_DELAY_MS)
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
      } else if (type === 'CTTBlu') {
        dev.attr.type = 'CTTBlu'
        dev.attr.radio = 'CTTBlu'
        matron.emit('cttBluIdentified', { port: dev.attr.port })
        matron.devices[dev.attr.port] = new BluBabel(matron, dev, options)
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
