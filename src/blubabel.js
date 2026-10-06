// blubabel.js — manage CTT BluSeries receivers
//
// CTT Blu uses an FTDI serial interface at 230400 baud. DTR low powers the
// receiver on. Commands and responses are newline-delimited JSON. Detection
// queues are polled independently on channels 1-4.
//
// Detections are written to the SG-native BluOut SafeStream using the same
// 11-column CSV schema that CTT SensorStation writes for directly attached
// BluSeries receivers. SG handles rotation/upload bookkeeping; the row contract
// remains CTT-compatible.

const {SerialPort} = require('serialport')

const BAUD_RATE = 230400
const BOOT_DELAY_MS = 1600
const POLL_INTERVAL_MS = 250
const CHANNELS = [1, 2, 3, 4]
const TYPE_VERSION = 1
const TYPE_DETECTIONS = 6

let debugId = 1

class BluBabel {
  constructor(matron, dev, options) {
    this.matron = matron
    this.dev = dev
    this.options = options ?? {}
    this.sp = null
    this.buffer = ''
    this.pollTimer = null
    this.pollIndex = 0
    this.retries = 0
    this.fwVersion = null

    this.matron.on('devRemoved', dev => this.devRemoved(dev))
    this.init_sp()
  }

  getPort() { return this.dev?.attr?.port ?? '?' }
  getPath() { return this.dev?.path ?? '<removed>' }

  close() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.sp) {
      if (this.sp.isOpen) this.sp.close()
      this.sp = null
    }
  }

  devRemoved(dev) {
    if (!this.dev || dev.path !== this.dev.path) return
    this.close()
    this.dev = null
  }

  init_sp() {
    if (!this.dev) return
    this.matron.emit('devState', this.getPort(), 'init')

    const path = this.dev.path
    const sp = new SerialPort({
      path,
      baudRate: BAUD_RATE,
      dataBits: 8,
      parity: 'none',
      stopBits: 1
    })
    const did = debugId++

    sp.on('open', () => {
      console.log(`Opened CTTBlu SerialPort #${did} ${path}`)
      sp.set({dtr: false}, err => {
        if (err) {
          this.fail(`failed to set DTR low: ${err.message}`)
          return
        }
        setTimeout(() => {
          if (!this.dev || !sp.isOpen) return
          this.send(TYPE_VERSION, 1)
          this.startPolling()
        }, BOOT_DELAY_MS)
      })
    })

    sp.on('data', data => {
      this.buffer += data.toString('utf8')
      this.processBuffer()
    })

    sp.on('close', () => {
      console.log(`CTTBlu SerialPort #${did} ${path} was closed`)
      if (this.dev && !this.dev.state?.startsWith('err'))
        this.matron.emit('devState', this.getPort(), 'error', 'port was closed')
    })

    sp.on('error', err => {
      console.log(`Error on CTTBlu SerialPort #${did} ${path}: ${err.message}`)
      if (this.dev) this.matron.emit('devState', this.getPort(), 'error', err.message)
      if (sp.isOpen) sp.close()
      if (this.dev && this.retries++ < 3) {
        setTimeout(() => this.init_sp(), this.retries < 3 ? 10000 : 60000)
      }
    })

    this.sp = sp
    console.log('Starting CTTBlu read stream using SerialPort at', path)
  }

  fail(msg) {
    console.log(`CTTBlu port ${this.getPort()}: ${msg}`)
    if (this.dev) this.matron.emit('devState', this.getPort(), 'error', msg)
  }

  send(type, channel) {
    if (!this.dev || !this.sp?.isOpen) return
    const command = JSON.stringify({type, channel, data: {}}) + '\r\n'
    this.sp.write(command, err => {
      if (err) this.fail(`write failed: ${err.message}`)
    })
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollIndex = 0
    this.pollTimer = setInterval(() => {
      const channel = CHANNELS[this.pollIndex]
      this.pollIndex = (this.pollIndex + 1) % CHANNELS.length
      this.send(TYPE_DETECTIONS, channel)
    }, POLL_INTERVAL_MS)
  }

  processBuffer() {
    let newline
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue

      const jsonStart = line.indexOf('{')
      if (jsonStart === -1) continue
      line = line.slice(jsonStart)

      let msg
      try {
        msg = JSON.parse(line)
      } catch (_) {
        console.log(`CTTBlu port ${this.getPort()}: invalid JSON: ${JSON.stringify(line)}`)
        continue
      }

      this.handleMessage(msg)
    }
  }

  handleMessage(msg) {
    if (msg?.type === TYPE_VERSION) {
      this.fwVersion = msg.data?.version ?? 'unknown'
      const app = msg.data?.app ?? 'unknown'
      console.log(`CTTBlu port ${this.getPort()}: firmware ${this.fwVersion}, app ${app}`)
      this.matron.emit('devState', this.getPort(), 'running')
      return
    }

    if (msg?.type !== TYPE_DETECTIONS) return
    if (!msg.data || Object.keys(msg.data).length === 0) return

    this.handleDetection(msg)
  }

  formatCttTime(timestampSeconds) {
    return new Date(timestampSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
  }

  handleDetection(msg) {
    const channel = msg.channel
    const data = msg.data ?? {}
    const currentTick = Number(data.current_tick_ms)
    const detectTick = Number(data.detect_tick_ms)
    const rssi = data.rssi

    let timestamp = Date.now() / 1000
    if (Number.isFinite(currentTick) && Number.isFinite(detectTick))
      timestamp -= (currentTick - detectTick) / 1000

    let decoded
    try {
      decoded = this.decodeDetection(data)
    } catch (err) {
      console.log(`CTTBlu port ${this.getPort()} ch${channel}: decode error: ${err.message}`)
      return
    }

    const cttRow = [
      this.getPort(),
      channel,
      '',
      this.formatCttTime(timestamp),
      rssi,
      decoded.tagId.toUpperCase(),
      decoded.sync,
      decoded.product,
      decoded.revision,
      '',
      decoded.rawPayloadHex.toUpperCase()
    ].join(',')

    if (typeof BluOut !== 'undefined') BluOut.write(cttRow + '\r\n')

    console.log(
      `CTTBlu detection port ${this.getPort()} ch${channel}: ` +
      `ts=${timestamp.toFixed(3)} tag=${decoded.tagId} rssi=${rssi} ` +
      `sync=${decoded.sync} product=${decoded.product} revision=${decoded.revision}` +
      (decoded.solar == null ? '' : ` solar=${decoded.solar.toFixed(3)}`) +
      (decoded.temp == null ? '' : ` temp=${decoded.temp.toFixed(2)}`) +
      (decoded.extraPayloadHex ? ` payload=${decoded.extraPayloadHex}` : '')
    )
  }

  decodeDetection(data) {
    if (data.encoding !== 'base64')
      throw new Error(`unsupported encoding ${data.encoding}`)
    if (typeof data.detection !== 'string')
      throw new Error('missing detection payload')

    const buf = Buffer.from(data.detection, 'base64')
    if (buf.length < 8)
      throw new Error(`payload too short (${buf.length} bytes)`)

    const out = {
      tagId: buf.slice(0, 4).toString('hex'),
      sync: buf.readUInt16LE(4),
      product: buf.readUInt8(6),
      revision: buf.readUInt8(7),
      solar: null,
      temp: null,
      rawPayloadHex: buf.length > 8 ? buf.slice(8).toString('hex') : '',
      extraPayloadHex: ''
    }

    if (out.revision === 0 && buf.length >= 12) {
      out.solar = buf.readUInt16LE(8) / 1000
      out.temp = buf.readUInt16LE(10) / 100
      if (buf.length > 12) out.extraPayloadHex = buf.slice(12).toString('hex')
    } else if (buf.length > 8) {
      out.extraPayloadHex = buf.slice(8).toString('hex')
    }

    return out
  }
}

module.exports = BluBabel
