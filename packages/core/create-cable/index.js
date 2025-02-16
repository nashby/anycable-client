import { Cable, GhostChannel } from '../cable/index.js'
import { ActionCableProtocol } from '../action_cable/index.js'
import { JSONEncoder } from '../encoder/index.js'
import { NoopLogger } from '../logger/index.js'
import { WebSocketTransport } from '../websocket/index.js'
import { Monitor, backoffWithJitter } from '../monitor/index.js'
import { SubscriptionRejectedError } from '../protocol/index.js'

export const DEFAULT_OPTIONS = {
  protocol: 'actioncable-v1-json',
  pingInterval: 3000,
  maxReconnectAttempts: Infinity,
  maxMissingPings: 2,
  logLevel: 'warn',
  lazy: true
}

export function createCable(url, opts) {
  if (typeof url === 'object' && typeof opts === 'undefined') {
    opts = url
    url = undefined
  }

  opts = opts || {}

  if (!url && !opts.transport) throw Error('URL or transport must be specified')

  opts = Object.assign({}, DEFAULT_OPTIONS, opts)

  let {
    protocol,
    websocketImplementation,
    websocketFormat,
    logLevel,
    logger,
    transport,
    encoder,
    lazy,
    monitor,
    pingInterval,
    reconnectStrategy,
    maxMissingPings,
    maxReconnectAttempts,
    subprotocol,
    tokenRefresher
  } = opts

  if (typeof protocol === 'string') subprotocol = subprotocol || protocol

  if (protocol === 'actioncable-v1-json') {
    protocol = new ActionCableProtocol()
    encoder = encoder || new JSONEncoder()
    websocketFormat = websocketFormat || 'text'
  } else if (protocol === 'actioncable-v1-msgpack') {
    protocol = new ActionCableProtocol()
    websocketFormat = 'binary'
    if (!encoder) {
      throw Error(
        'Msgpack encoder must be specified explicitly. Use `@anycable/msgpack-encoder` package or build your own'
      )
    }
  } else if (protocol === 'actioncable-v1-protobuf') {
    protocol = new ActionCableProtocol()
    websocketFormat = websocketFormat || 'binary'
    if (!encoder) {
      throw Error(
        'Protobuf encoder must be specified explicitly. Use `@anycable/protobuf-encoder` package or build your own'
      )
    }
  } else if (typeof protocol === 'string') {
    throw Error(`Protocol is not supported yet: ${protocol}`)
  }

  if (!protocol) throw Error('Protocol must be specified')

  transport =
    transport ||
    new WebSocketTransport(url, {
      websocketImplementation,
      subprotocol,
      format: websocketFormat
    })

  logger = logger || new NoopLogger(logLevel)

  reconnectStrategy = reconnectStrategy || backoffWithJitter(pingInterval)

  if (monitor !== false) {
    monitor =
      monitor ||
      new Monitor({
        pingInterval,
        reconnectStrategy,
        maxMissingPings,
        maxReconnectAttempts,
        logger
      })
  }

  let cable = new Cable({
    protocol,
    transport,
    encoder,
    logger,
    lazy
  })

  if (monitor) {
    monitor.watch(cable)
    cable.monitor = monitor
  }

  if (tokenRefresher) {
    watchForExpiredToken(cable, async () => {
      try {
        await tokenRefresher(transport)
        await cable.connect()
        return true
      } catch (err) {
        logger.info('Failed to refresh authentication token: ' + err)
      }

      return false
    })
  }

  return cable
}

function watchForExpiredToken(cable, callback) {
  let unbind = cable.on('close', async ev => {
    if (ev.reason === 'token_expired') {
      unbind()
      let result = await callback()

      if (result) watchForExpiredToken(cable, callback)
    }
  })
}

class ActionCableChannel extends GhostChannel {
  constructor(channelName, params, mixin) {
    super(channelName, params)

    for (let key in mixin) {
      let value = mixin[key]
      // Use prefix to avoid collisions with Channel
      this[`_ac_${key}`] = value
    }

    this.on('connect', () => this.notify('_ac_connected'))
    this.on('disconnect', () =>
      this.notify('_ac_disconnected', { allowReconnect: true })
    )
    this.on('message', val => this.notify('_ac_received', val))
    this.on('close', err => {
      if (err && err instanceof SubscriptionRejectedError) {
        this.notify('_ac_rejected')
      } else {
        this.notify('_ac_disconnected', { allowReconnect: false })
      }
    })
  }

  notify(callback, ...args) {
    if (typeof this[callback] !== 'function') return

    this[callback](...args)
  }

  unsubscribe() {
    return this.disconnect()
  }
}

export class ActionCableSubscriptions {
  constructor(cable) {
    this.cable = cable
  }

  create(channel, mixin) {
    let channelName
    let params

    if (typeof channel === 'object') {
      channelName = channel.channel
      delete channel.channel
      params = channel
    } else {
      channelName = channel
      params = {}
    }

    let cableChannel = new ActionCableChannel(channelName, params, mixin)
    cableChannel.notify('_ac_initialized')

    this.cable.subscribe(cableChannel).catch(() => {})

    return cableChannel
  }
}

export class ActionCableConsumer {
  constructor(cable) {
    this.cable = cable
    this.subscriptions = new ActionCableSubscriptions(cable)
  }
}

export function createConsumer(url, opts) {
  let cable = createCable(url, opts)

  return new ActionCableConsumer(cable)
}
