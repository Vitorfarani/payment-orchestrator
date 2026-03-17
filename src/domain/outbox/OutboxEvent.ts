import { randomUUID } from 'crypto'

export type OutboxPayload = Readonly<Record<string, unknown>>

interface OutboxEventProps {
  readonly id:            string
  readonly eventType:     string
  readonly aggregateId:   string
  readonly aggregateType: string
  readonly payload:       OutboxPayload
  readonly processed:     boolean
  readonly retryCount:    number
  readonly createdAt:     Date
  readonly processedAt?:  Date
  readonly error?:        string
}

interface CreateOutboxEventInput {
  readonly eventType:     string
  readonly aggregateId:   string
  readonly aggregateType: string
  readonly payload:       OutboxPayload
}

/**
 * Envelope imutável de um evento de domínio para publicação atômica (ADR-009).
 *
 * Criado dentro da mesma transação que persiste a mudança de estado.
 * O OutboxRelay lê esta entidade e publica no BullMQ com jobId = id.
 */
export class OutboxEvent {
  private readonly props: OutboxEventProps

  private constructor(props: OutboxEventProps) {
    this.props = props
  }

  get id():            string             { return this.props.id }
  get eventType():     string             { return this.props.eventType }
  get aggregateId():   string             { return this.props.aggregateId }
  get aggregateType(): string             { return this.props.aggregateType }
  get payload():       OutboxPayload      { return this.props.payload }
  get processed():     boolean            { return this.props.processed }
  get retryCount():    number             { return this.props.retryCount }
  get createdAt():     Date               { return this.props.createdAt }
  get processedAt():   Date | undefined   { return this.props.processedAt }
  get error():         string | undefined { return this.props.error }

  /** Cria um novo evento não-processado. Chamado pelo use case antes de salvar no banco. */
  static create(input: CreateOutboxEventInput): OutboxEvent {
    return new OutboxEvent({
      id:            randomUUID(),
      eventType:     input.eventType,
      aggregateId:   input.aggregateId,
      aggregateType: input.aggregateType,
      payload:       input.payload,
      processed:     false,
      retryCount:    0,
      createdAt:     new Date(),
    })
  }

  /** Rehidrata a entidade a partir de uma linha do banco. Usado pelo repositório. */
  static reconstitute(props: OutboxEventProps): OutboxEvent {
    return new OutboxEvent(props)
  }
}
