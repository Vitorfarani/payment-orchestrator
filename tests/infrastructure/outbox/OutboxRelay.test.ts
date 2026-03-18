import type { Logger } from 'pino'
import { OutboxEvent } from '../../../src/domain/outbox/OutboxEvent'
import type { IOutboxRepository } from '../../../src/domain/outbox/IOutboxRepository'
import { OutboxRelay } from '../../../src/infrastructure/outbox/OutboxRelay'
import type { QueueLike } from '../../../src/infrastructure/outbox/OutboxRelay'

// Mock do módulo de métricas — deve vir antes de qualquer import que use metrics
jest.mock('../../../src/infrastructure/metrics/metrics', () => ({
  outboxUnprocessedEventsTotal: { set: jest.fn() },
  outboxRelayLagSeconds:        { set: jest.fn() },
}))

import {
  outboxUnprocessedEventsTotal,
  outboxRelayLagSeconds,
} from '../../../src/infrastructure/metrics/metrics'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: {
  id?:        string
  eventType?: string
  createdAt?: Date
} = {}): OutboxEvent {
  return OutboxEvent.reconstitute({
    id:            overrides.id        ?? 'evt-1',
    eventType:     overrides.eventType ?? 'payment.captured',
    aggregateId:   'pay-1',
    aggregateType: 'Payment',
    payload:       { paymentId: 'pay-1' },
    processed:     false,
    retryCount:    0,
    createdAt:     overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
  })
}

function makeRepo(events: OutboxEvent[] = []): jest.Mocked<IOutboxRepository> {
  return {
    save:                 jest.fn<Promise<void>, [OutboxEvent]>(),
    findUnprocessedBatch: jest.fn().mockResolvedValue(events),
    markProcessed:        jest.fn().mockResolvedValue(undefined),
    recordFailure:        jest.fn().mockResolvedValue(undefined),
  }
}

function makeQueue(): jest.Mocked<QueueLike> {
  return { add: jest.fn().mockResolvedValue(undefined) }
}

function makeLogger(): Logger {
  return {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('OutboxRelay', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  // ─── processOnce() ──────────────────────────────────────────────────────────

  describe('processOnce()', () => {
    it('does nothing when there are no unprocessed events', async () => {
      const repo  = makeRepo([])
      const queue = makeQueue()
      const relay = new OutboxRelay({
        outboxRepo:   repo,
        resolveQueue: () => queue,
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(queue.add).not.toHaveBeenCalled()
      expect(repo.markProcessed).not.toHaveBeenCalled()
    })

    it('sets outboxUnprocessedEventsTotal to the number of pending events', async () => {
      const events = [makeEvent({ id: 'evt-1' }), makeEvent({ id: 'evt-2' })]
      const relay  = new OutboxRelay({
        outboxRepo:   makeRepo(events),
        resolveQueue: () => makeQueue(),
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(jest.mocked(outboxUnprocessedEventsTotal.set)).toHaveBeenCalledWith(2)
    })

    it('sets outboxUnprocessedEventsTotal to 0 when there are no events', async () => {
      const relay = new OutboxRelay({
        outboxRepo:   makeRepo([]),
        resolveQueue: () => makeQueue(),
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(jest.mocked(outboxUnprocessedEventsTotal.set)).toHaveBeenCalledWith(0)
    })

    it('publishes each event with its eventType, payload and jobId = event.id', async () => {
      const event = makeEvent({ id: 'evt-abc', eventType: 'payment.captured' })
      const queue = makeQueue()
      const relay = new OutboxRelay({
        outboxRepo:   makeRepo([event]),
        resolveQueue: () => queue,
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(queue.add).toHaveBeenCalledWith(
        'payment.captured',
        event.payload,
        { jobId: 'evt-abc' },
      )
    })

    it('marks each event as processed after successful publish', async () => {
      const event = makeEvent({ id: 'evt-abc' })
      const repo  = makeRepo([event])
      const relay = new OutboxRelay({
        outboxRepo:   repo,
        resolveQueue: () => makeQueue(),
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(repo.markProcessed).toHaveBeenCalledWith('evt-abc', expect.any(Date))
    })

    it('sets outboxRelayLagSeconds after successful publish', async () => {
      const createdAt = new Date('2024-01-01T00:00:00.000Z')
      const relay     = new OutboxRelay({
        outboxRepo:   makeRepo([makeEvent({ createdAt })]),
        resolveQueue: () => makeQueue(),
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(jest.mocked(outboxRelayLagSeconds.set)).toHaveBeenCalledWith(
        expect.any(Number),
      )
    })

    it('lag value is a non-negative number', async () => {
      const createdAt = new Date(Date.now() - 500) // 500ms atrás — lag sempre >= 0
      const relay     = new OutboxRelay({
        outboxRepo:   makeRepo([makeEvent({ createdAt })]),
        resolveQueue: () => makeQueue(),
        logger:       makeLogger(),
      })

      await relay.processOnce()

      // Verifica que foi chamado com um número >= 0
      // (lag = (now - createdAt) / 1000; createdAt no passado → sempre positivo)
      expect(jest.mocked(outboxRelayLagSeconds.set)).toHaveBeenCalledWith(
        expect.any(Number),
      )
      const mockSet  = jest.mocked(outboxRelayLagSeconds.set)
      const lastCall = mockSet.mock.lastCall
      expect(lastCall).toBeDefined()
      if (lastCall !== undefined) {
        expect(lastCall[0]).toBeGreaterThanOrEqual(0)
      }
    })

    it('calls recordFailure when queue.add throws', async () => {
      const event = makeEvent({ id: 'evt-fail' })
      const queue = makeQueue()
      queue.add.mockRejectedValue(new Error('Redis unavailable'))
      const repo  = makeRepo([event])
      const relay = new OutboxRelay({
        outboxRepo:   repo,
        resolveQueue: () => queue,
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(repo.recordFailure).toHaveBeenCalledWith('evt-fail', 'Redis unavailable')
    })

    it('does not mark as processed when queue.add throws', async () => {
      const queue = makeQueue()
      queue.add.mockRejectedValue(new Error('Redis unavailable'))
      const repo  = makeRepo([makeEvent()])
      const relay = new OutboxRelay({
        outboxRepo:   repo,
        resolveQueue: () => queue,
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(repo.markProcessed).not.toHaveBeenCalled()
    })

    it('continues processing remaining events when one fails', async () => {
      const failEvent = makeEvent({ id: 'evt-fail' })
      const okEvent   = makeEvent({ id: 'evt-ok' })
      const queue     = makeQueue()
      queue.add
        .mockRejectedValueOnce(new Error('Redis unavailable'))
        .mockResolvedValueOnce(undefined)
      const repo  = makeRepo([failEvent, okEvent])
      const relay = new OutboxRelay({
        outboxRepo:   repo,
        resolveQueue: () => queue,
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(repo.recordFailure).toHaveBeenCalledWith('evt-fail', expect.any(String))
      expect(repo.markProcessed).toHaveBeenCalledWith('evt-ok', expect.any(Date))
    })

    it('calls recordFailure when no queue is configured for the event type', async () => {
      const event = makeEvent({ eventType: 'unknown.event.type' })
      const repo  = makeRepo([event])
      const relay = new OutboxRelay({
        outboxRepo:   repo,
        resolveQueue: () => undefined, // nenhuma fila para este tipo
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(repo.recordFailure).toHaveBeenCalledWith(
        event.id,
        expect.stringContaining('No queue configured'),
      )
    })

    it('does not mark as processed when no queue is configured', async () => {
      const repo  = makeRepo([makeEvent()])
      const relay = new OutboxRelay({
        outboxRepo:   repo,
        resolveQueue: () => undefined,
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(repo.markProcessed).not.toHaveBeenCalled()
    })

    it('requests batch with default limit of 100', async () => {
      const repo  = makeRepo([])
      const relay = new OutboxRelay({
        outboxRepo:   repo,
        resolveQueue: () => makeQueue(),
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(repo.findUnprocessedBatch).toHaveBeenCalledWith(100)
    })

    it('respects a custom batchSize', async () => {
      const repo  = makeRepo([])
      const relay = new OutboxRelay({
        outboxRepo:   repo,
        resolveQueue: () => makeQueue(),
        logger:       makeLogger(),
        batchSize:    50,
      })

      await relay.processOnce()

      expect(repo.findUnprocessedBatch).toHaveBeenCalledWith(50)
    })

    it('handles non-Error thrown values in recordFailure message', async () => {
      const queue = makeQueue()
      queue.add.mockRejectedValue('string error') // não é Error — é string
      const repo  = makeRepo([makeEvent({ id: 'evt-str' })])
      const relay = new OutboxRelay({
        outboxRepo:   repo,
        resolveQueue: () => queue,
        logger:       makeLogger(),
      })

      await relay.processOnce()

      expect(repo.recordFailure).toHaveBeenCalledWith('evt-str', 'string error')
    })
  })

  // ─── start() / stop() ───────────────────────────────────────────────────────

  describe('start() and stop()', () => {
    it('stop() causes start() to resolve — loop terminates', async () => {
      const relay = new OutboxRelay({
        outboxRepo:        makeRepo([]),
        resolveQueue:      () => makeQueue(),
        logger:            makeLogger(),
        pollingIntervalMs: 0, // sem sleep real — não bloqueia o teste
      })

      const started = relay.start()
      relay.stop()

      await expect(started).resolves.toBeUndefined()
    })

    it('stop() sets isRunning to false — processOnce is not called again', async () => {
      const repo  = makeRepo([])
      const relay = new OutboxRelay({
        outboxRepo:        repo,
        resolveQueue:      () => makeQueue(),
        logger:            makeLogger(),
        pollingIntervalMs: 0,
      })

      const started = relay.start()
      relay.stop()
      await started

      // Com pollingIntervalMs=0 e stop() chamado imediatamente, no máximo 1-2 ciclos
      expect(repo.findUnprocessedBatch.mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(repo.findUnprocessedBatch.mock.calls.length).toBeLessThanOrEqual(2)
    })
  })
})
