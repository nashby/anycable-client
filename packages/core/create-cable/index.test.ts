import { jest } from '@jest/globals'

import {
  createCable,
  ActionCableProtocol,
  WebSocketTransport,
  Message,
  createConsumer,
  Transport,
  SubscriptionRejectedError,
  DisconnectedError
} from '../index.js'
import { TestTransport } from '../transport/testing'

it('requires url or transport', () => {
  expect(() => createCable()).toThrow(/url or transport must be specified/i)
})

it('with transport', () => {
  let tt = new TestTransport('ws://anycable.test')
  let cable = createCable({ transport: tt })

  expect(cable.transport).toBe(tt)
})

it('defaults', () => {
  let cable = createCable('ws://example')
  expect(cable.protocol).toBeInstanceOf(ActionCableProtocol)
  expect(cable.transport).toBeInstanceOf(WebSocketTransport)

  let ws = cable.transport as WebSocketTransport
  expect(ws.url).toEqual('ws://example')

  expect(cable.logger.level).toEqual('warn')
})

it('unsupported protocol', () => {
  expect(() =>
    // We want to make sure, that `createCable` throws an error
    // for unsupported protocols in runtime. Since TS doesn't allow to
    // pass arbitrary string as protocol, we ignore it for this particular test
    //
    // @ts-ignore
    createCable('ws://example', { protocol: 'actioncable-v1-whatever' })
  ).toThrow(/protocol is not supported/i)
})

it('missing protocol', () => {
  expect(() => createCable('ws://example', { protocol: undefined })).toThrow(
    /protocol must be specified/i
  )
})

it('missing encoder when required', () => {
  expect(() =>
    createCable('ws://example', { protocol: 'actioncable-v1-msgpack' })
  ).toThrow(/encoder must be specified/i)

  expect(() =>
    createCable('ws://example', { protocol: 'actioncable-v1-protobuf' })
  ).toThrow(/encoder must be specified/i)
})

it('with monitor=false', () => {
  let cable = createCable('ws://example', { monitor: false })

  expect(cable.monitor).toBeUndefined()
})

describe('with tokenRefresher', () => {
  let transport: TestTransport

  beforeEach(() => {
    transport = new TestTransport('ws://anycable.test')
  })

  it('success', () => {
    let refresher = (t: Transport) => {
      t.setURL('ws://anycable-new.test')
      return Promise.resolve()
    }

    let cable = createCable('ws://example', {
      tokenRefresher: refresher,
      transport
    })
    cable.connected()
    cable.close('token_expired')

    let spy = jest.spyOn(cable, 'connect')

    return new Promise<void>(resolve => {
      transport.once('open', () => {
        cable.connected()
        expect(transport.url).toEqual('ws://anycable-new.test')
        expect(spy).toHaveBeenCalledTimes(1)
        resolve()
      })
    })
  })

  it('when not updated', () => {
    let called = 0
    let refresher = (t: Transport) => {
      called++
      t.setURL('ws://anycable-new.test')
      return Promise.reject(Error('no token in the response'))
    }

    let cable = createCable('ws://example', {
      tokenRefresher: refresher,
      transport
    })
    cable.connected()
    let spy = jest.spyOn(cable, 'connect')

    cable.close('token_expired')
    expect(spy).toHaveBeenCalledTimes(0)
    expect(called).toEqual(1)

    // Check that we're ignoring subsequent disconnects
    cable.connected()
    cable.close('token_expired')

    expect(called).toEqual(1)
  })

  it('multiple expirations', async () => {
    let called = 0
    let refresher = (t: Transport) => {
      called++
      t.setURL('ws://anycable-new.test')
      return Promise.resolve()
    }

    let cable = createCable('ws://example', {
      tokenRefresher: refresher,
      transport
    })
    cable.connected()
    cable.close('token_expired')

    expect(called).toEqual(1)
    expect(transport.url).toEqual('ws://anycable-new.test')

    cable.connected()

    // A hack to make sure all async functions have been resolved
    await new Promise<void>(resolve => setTimeout(resolve, 100))

    cable.close('token_expired')
    expect(called).toEqual(2)
  })

  it('when connection failed', () => {
    let called = 0
    let refresher = (t: Transport) => {
      called++
      t.setURL('ws://anycable-new.test')
      return Promise.resolve()
    }

    let cable = createCable('ws://example', {
      tokenRefresher: refresher,
      transport
    })
    cable.connected()
    jest
      .spyOn(cable, 'connect')
      .mockImplementation(() => Promise.reject(new DisconnectedError('failed')))

    cable.close('token_expired')
    expect(called).toEqual(1)

    // Check that we're ignoring subsequent disconnects
    cable.connected()
    cable.close('token_expired')

    expect(called).toEqual(1)
  })
})

type TestMixin = {
  initialized: () => void
  connected: () => void
  rejected: () => void
  received: (data: Message) => void
  disconnected: () => void
  callbacks: string[]
  messages: Message[]
}

describe('createConsumer', () => {
  let mixin: TestMixin

  beforeEach(() => {
    /* eslint-disable object-shorthand */
    mixin = {
      callbacks: [],
      messages: [],
      initialized: function () {
        let self = this as unknown as TestMixin
        self.callbacks = ['initialized']
        self.messages = []
      },
      connected: function () {
        let self = this as unknown as TestMixin
        self.callbacks.push('connected')
      },
      rejected: function () {
        let self = this as unknown as TestMixin
        self.callbacks.push('rejected')
      },
      received: function (data: Message) {
        let self = this as unknown as TestMixin
        self.messages.push(data)
      },
      disconnected: function () {
        let self = this as unknown as TestMixin
        self.callbacks.push('disconnected')
      }
    }
  })

  it('subscriptions + message + unsubscribe', async () => {
    let consumer = createConsumer('ws://example')
    let cable = consumer.cable
    cable.connected()

    expect(cable.protocol).toBeInstanceOf(ActionCableProtocol)

    jest.spyOn(cable.protocol, 'subscribe').mockImplementation(() => {
      return Promise.resolve('2020')
    })

    let channel = consumer.subscriptions.create<TestMixin>(
      {
        channel: 'some_channel',
        id: '2020'
      },
      mixin
    )

    expect(channel.callbacks).toContain('initialized')

    await new Promise<void>(resolve => channel.once('connect', resolve))

    expect(cable.hub.size).toEqual(1)
    expect(channel.state).toEqual('connected')
    expect(channel.callbacks).toContain('connected')

    let message = { foo: 'bar' }

    channel.receive(message)

    expect(channel.messages).toEqual([message])

    jest.spyOn(cable.protocol, 'unsubscribe').mockImplementation(() => {
      return Promise.resolve()
    })

    channel.unsubscribe()

    await new Promise<void>(resolve =>
      channel.once('close', () => {
        resolve()
      })
    )

    expect(channel.callbacks).toContain('disconnected')
  })

  it('subscriptions + rejected', async () => {
    let consumer = createConsumer('ws://example')
    let cable = consumer.cable
    cable.connected()

    expect(cable.protocol).toBeInstanceOf(ActionCableProtocol)

    jest.spyOn(cable.protocol, 'subscribe').mockImplementation(() => {
      return Promise.reject(new SubscriptionRejectedError('Forbidden'))
    })

    let channel = consumer.subscriptions.create<TestMixin>(
      {
        channel: 'some_channel',
        id: '2020'
      },
      mixin
    )

    expect(channel.callbacks).toContain('initialized')

    await new Promise<void>(resolve =>
      channel.once('close', () => {
        resolve()
      })
    )
    expect(channel.callbacks).toContain('rejected')
  })

  it('subscription without params + disconnect', async () => {
    let consumer = createConsumer('ws://example')
    let cable = consumer.cable
    cable.connected()

    expect(cable.protocol).toBeInstanceOf(ActionCableProtocol)

    jest.spyOn(cable.protocol, 'subscribe').mockImplementation(() => {
      return Promise.resolve('2020')
    })

    let channel = consumer.subscriptions.create<TestMixin>(
      'some_channel',
      mixin
    )

    expect(channel.callbacks).toContain('initialized')

    await new Promise<void>(resolve =>
      channel.once('connect', () => {
        resolve()
      })
    )

    expect(channel.callbacks).toContain('connected')

    cable.disconnected()

    expect(channel.callbacks).toContain('disconnected')
  })

  it('subscription with partial mixin', async () => {
    let consumer = createConsumer('ws://example')
    let cable = consumer.cable
    cable.connected()

    expect(cable.protocol).toBeInstanceOf(ActionCableProtocol)

    jest.spyOn(cable.protocol, 'subscribe').mockImplementation(() => {
      return Promise.resolve('2020')
    })

    let data: Message[] = []

    let minimalMixin = {
      received: (msg: Message) => data.push(msg)
    }

    let channel = consumer.subscriptions.create<TestMixin>(
      'some_channel',
      minimalMixin
    )

    await new Promise<void>(resolve =>
      channel.once('connect', () => {
        resolve()
      })
    )

    let message = { foo: 'bar' }

    channel.receive(message)

    expect(data).toEqual([message])
  })
})
