import type { Logger } from 'pino'
import { LedgerRefreshWorker } from '../../../src/infrastructure/queue/workers/LedgerRefreshWorker'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger
}

function makeLedgerQueryRepo(shouldFail = false): { refreshView: jest.Mock } {
  return {
    refreshView: shouldFail
      ? jest.fn().mockRejectedValue(new Error('DB connection lost'))
      : jest.fn().mockResolvedValue(undefined),
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('LedgerRefreshWorker', () => {
  afterEach(() => jest.clearAllMocks())

  it('chama refreshView() na materialized view', async () => {
    const repo   = makeLedgerQueryRepo()
    const worker = new LedgerRefreshWorker({ ledgerQueryRepo: repo, logger: makeLogger() })

    await worker.refresh()

    expect(repo.refreshView).toHaveBeenCalledTimes(1)
  })

  it('loga mensagem de sucesso após refresh', async () => {
    const repo   = makeLedgerQueryRepo()
    const logger = makeLogger()
    const worker = new LedgerRefreshWorker({ ledgerQueryRepo: repo, logger })

    await worker.refresh()

    expect((logger.info as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'LedgerRefreshWorker' }),
      expect.any(String),
    )
  })

  it('não lança exceção quando refreshView() falha — loga erro e retorna', async () => {
    const repo   = makeLedgerQueryRepo(true)
    const logger = makeLogger()
    const worker = new LedgerRefreshWorker({ ledgerQueryRepo: repo, logger })

    await expect(worker.refresh()).resolves.not.toThrow()

    expect((logger.error as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'LedgerRefreshWorker' }),
      expect.any(String),
    )
  })
})
