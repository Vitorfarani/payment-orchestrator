import type { Logger } from 'pino'
import { GracefulShutdown, type ShutdownDeps } from '../../src/infrastructure/GracefulShutdown'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger
}

/**
 * Cria um `server.close` que chama o callback de forma síncrona (sem erro).
 * Simula o comportamento do http.Server após fechar sem requests pendentes.
 */
function makeServer(error?: Error): ShutdownDeps['server'] {
  return {
    close: jest.fn().mockImplementation((cb: (err?: Error) => void) => cb(error)),
  }
}

function makeWorker(): { close: jest.Mock } {
  return { close: jest.fn().mockResolvedValue(undefined) }
}

function makeRelay(): { stop: jest.Mock } {
  return { stop: jest.fn() }
}

function makeDb(): { destroy: jest.Mock } {
  return { destroy: jest.fn().mockResolvedValue(undefined) }
}

function makeRedis(): { quit: jest.Mock } {
  return { quit: jest.fn().mockResolvedValue('OK') }
}

function makeDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps {
  return {
    server:  makeServer(),
    workers: [makeWorker()],
    relay:   makeRelay(),
    db:      makeDb(),
    redis:   makeRedis(),
    logger:  makeLogger(),
    ...overrides,
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('GracefulShutdown', () => {
  let exitSpy: jest.SpyInstance

  beforeEach(() => {
    // Impede process.exit de encerrar o processo durante os testes
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    jest.clearAllMocks()
  })

  // ── Registro de signal handlers ─────────────────────────────────────────────

  describe('register', () => {
    it('registra handlers para SIGTERM e SIGINT sem lançar exceção', () => {
      const deps     = makeDeps()
      const shutdown = new GracefulShutdown(deps)

      expect(() => shutdown.register()).not.toThrow()
    })

    it('não dispara shutdown ao chamar register (apenas registra os handlers)', () => {
      const deps     = makeDeps()
      const shutdown = new GracefulShutdown(deps)
      shutdown.register()

      expect(deps.server.close).not.toHaveBeenCalled()
    })
  })

  // ── Fluxo de shutdown limpo ─────────────────────────────────────────────────

  describe('shutdown happy path', () => {
    it('fecha HTTP server, para relay, drena workers, fecha DB e Redis em ordem', async () => {
      const callOrder: string[] = []
      const server = {
        close: jest.fn().mockImplementation((cb: (err?: Error) => void) => {
          callOrder.push('server.close')
          cb()
        }),
      }
      const worker = { close: jest.fn().mockImplementation(async () => { callOrder.push('worker.close') }) }
      const relay  = { stop:  jest.fn().mockImplementation(() => { callOrder.push('relay.stop') }) }
      const db     = { destroy: jest.fn().mockImplementation(async () => { callOrder.push('db.destroy') }) }
      const redis  = { quit: jest.fn().mockImplementation(async () => { callOrder.push('redis.quit'); return 'OK' }) }

      const shutdown = new GracefulShutdown({ server, workers: [worker], relay, db, redis, logger: makeLogger() })

      await shutdown.shutdown('SIGTERM')

      expect(callOrder).toEqual(['server.close', 'relay.stop', 'worker.close', 'db.destroy', 'redis.quit'])
    })

    it('chama process.exit(0) após shutdown limpo', async () => {
      const deps     = makeDeps()
      const shutdown = new GracefulShutdown(deps)

      await shutdown.shutdown('SIGTERM')

      expect(exitSpy).toHaveBeenCalledWith(0)
    })

    it('drena todos os workers antes de fechar as conexões', async () => {
      const worker1 = makeWorker()
      const worker2 = makeWorker()
      const db      = makeDb()

      // Garante que workers.close é chamado antes de db.destroy
      let workersClosedBeforeDb = false
      worker1.close.mockImplementation(async () => { workersClosedBeforeDb = !db.destroy.mock.calls.length })

      const shutdown = new GracefulShutdown({
        ...makeDeps(),
        workers: [worker1, worker2],
        db,
      })

      await shutdown.shutdown('SIGTERM')

      expect(workersClosedBeforeDb).toBe(true)
      expect(worker1.close).toHaveBeenCalled()
      expect(worker2.close).toHaveBeenCalled()
    })
  })

  // ── Shutdown com erro ───────────────────────────────────────────────────────

  describe('shutdown com erro', () => {
    it('chama process.exit(1) quando server.close retorna erro', async () => {
      const deps = makeDeps({ server: makeServer(new Error('server error')) })
      const shutdown = new GracefulShutdown(deps)

      await shutdown.shutdown('SIGTERM')

      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('chama process.exit(1) quando worker.close lança exceção', async () => {
      const failingWorker = { close: jest.fn().mockRejectedValue(new Error('worker stuck')) }
      const shutdown = new GracefulShutdown({ ...makeDeps(), workers: [failingWorker] })

      await shutdown.shutdown('SIGTERM')

      expect(exitSpy).toHaveBeenCalledWith(1)
    })
  })

  // ── Guard dupla chamada ─────────────────────────────────────────────────────

  describe('guard isShuttingDown', () => {
    it('ignora chamadas subsequentes ao shutdown (evita duplo-exit)', async () => {
      const deps     = makeDeps()
      const shutdown = new GracefulShutdown(deps)

      await shutdown.shutdown('SIGTERM')
      await shutdown.shutdown('SIGTERM')  // segunda chamada deve ser ignorada

      expect(deps.server.close).toHaveBeenCalledTimes(1)
    })
  })
})
