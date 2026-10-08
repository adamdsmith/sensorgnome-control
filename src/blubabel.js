// blubabel.js — manage CTT BluSeries receivers
//
// CTT Blu uses an FTDI serial interface at 230400 baud. DTR low powers the
// receiver on. Commands and responses are newline-delimited JSON. Detection
// queues are polled independently on channels 1-4.
//
// Detections are decoded from the receiver, timestamped from receiver tick
// counters, and emitted to SensorGnome for live use.

const {SerialPort} = require('serialport')

const BAUD_RATE = 230400
const BOOT_DELAY_MS = 1600
const POLL_INTERVAL_MS = 250
const POLL_TIMEOUT_MS = 5000
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
    this.closing = false
    this.buffer = ''
    this.pollTimer = null
    this.pollTimeout = null
    this.retryTimer = null
    this.pollIndex = 0
    this.awaitingChannel = null
    this.retries = 0
    this.fwVersion = null

    this.onDevRemoved = dev => this.devRemoved(dev)
    this.matron.on('devRemoved', this.onDevRemoved)
    this.init_sp()
  }

  getPort() { return this.dev?.attr?.port ?? '?' }
  getPath() { return this.dev?.path ?? '<removed>' }

  close() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout)
      this.pollTimeout = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.awaitingChannel = null
    if (this.sp) {
      this.closing = true
      if (this.sp.isOpen) this.sp.close()
      this.sp = null
    }
  }

  devRemoved(dev) {
    if (!this.dev || dev.path !== this.dev.path) return
    this.matron.removeListener('devRemoved', this.onDevRemoved)
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
      if (sp !== this.sp) return
      this.closing = false
      console.log(`Opened CTTBlu SerialPort #${did} ${path}`)
      sp.set({dtr: false}, err => {
        if (err) {
          this.fail(`failed to set DTR low: ${err.message}`)
          return
        }
        setTimeout(() => {
          if (!this.dev || !sp.isOpen) return
          this.send(TYPE_VERSION, 1)
        }, BOOT_DELAY_MS)
      })
    })

    sp.on('data', data => {
      if (sp !== this.sp) return
      this.buffer += data.toString('utf8')
      this.processBuffer()
    })

    sp.on('close', () => {
      if (sp !== this.sp) return
      console.log(`CTTBlu SerialPort #${did} ${path} was closed`)
      if (!this.closing && this.dev && !this.dev.state?.startsWith('err'))
        this.matron.emit('devState', this.getPort(), 'error', 'port was closed')
    })

    sp.on('error', err => {
      if (sp !== this.sp) return
      console.log(`Error on CTTBlu SerialPort #${did} ${path}: ${err.message}`)
      if (this.dev) this.matron.emit('devState', this.getPort(), 'error', err.message)
      if (sp.isOpen) sp.close()
      if (this.dev && !this.retryTimer && this.retries++ < 3) {
        const delay = this.retries < 3 ? 10000 : 60000
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          this.init_sp()
        }, delay)
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
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollIndex = 0
    this.awaitingChannel = null
    this.scheduleNextPoll()
  }

  scheduleNextPoll() {
    if (!this.dev || !this.sp?.isOpen || this.awaitingChannel != null) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      if (!this.dev || !this.sp?.isOpen || this.awaitingChannel != null) return
      const channel = CHANNELS[this.pollIndex]
      this.awaitingChannel = channel
      this.send(TYPE_DETECTIONS, channel)
      this.pollTimeout = setTimeout(() => this.pollTimedOut(channel), POLL_TIMEOUT_MS)
    }, POLL_INTERVAL_MS)
  }

  finishPoll(channel) {
    if (channel !== this.awaitingChannel) return
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout)
      this.pollTimeout = null
    }
    this.awaitingChannel = null
    this.pollIndex = (this.pollIndex + 1) % CHANNELS.length
    this.scheduleNextPoll()
  }

  pollTimedOut(channel) {
    if (channel !== this.awaitingChannel) return
    this.pollTimeout = null
    console.log(`CTTBlu port ${this.getPort()} ch${channel}: detection poll timed out`)
    this.awaitingChannel = null
    this.pollIndex = (this.pollIndex + 1) % CHANNELS.length
    this.scheduleNextPoll()
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
      this.retries = 0
      this.matron.emit('devState', this.getPort(), 'running')
      this.startPolling()
      return
    }

    if (msg?.type !== TYPE_DETECTIONS) return

    if (msg.channel !== this.awaitingChannel) {
      console.log(
        `CTTBlu port ${this.getPort()} ch${msg.channel}: ignoring late detection response`
      )
      return
    }

    if (!msg.data || Object.keys(msg.data).length === 0) {
      this.finishPoll(msg.channel)
      return
    }

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

    this.matron.emit('bluDetection', {
      port: this.getPort(),
      channel,
      timestamp,
      rssi,
      tagId: decoded.tagId.toUpperCase(),
      sync: decoded.sync,
      product: decoded.product,
      revision: decoded.revision,
      temp: decoded.temp,
      solar: decoded.solar
    })

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
