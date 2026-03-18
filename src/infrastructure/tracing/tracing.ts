import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

/**
 * Instância do SDK — mantida no módulo para permitir shutdown gracioso.
 * `null` enquanto o tracing não foi inicializado ou está desabilitado.
 */
let sdk: NodeSDK | null = null

/**
 * Inicializa o OpenTelemetry SDK.
 *
 * Deve ser chamado antes de qualquer outro import de infra (Express, Knex,
 * HTTP clients) para que a instrumentação automática seja aplicada.
 * Em `NODE_ENV=test` é um no-op — evita overhead e conflitos em testes.
 *
 * Instrumentações automáticas ativadas (ADR-017):
 * - Express (requests HTTP de entrada)
 * - pg / PostgreSQL via Knex (queries ao banco)
 * - HTTP / HTTPS (chamadas ao gateway externo)
 * - BullMQ workers (jobs de processamento)
 *
 * Em desenvolvimento, exporta para Jaeger via OTLP HTTP (localhost:4318).
 * Em produção, o endpoint é configurado via `OTEL_EXPORTER_OTLP_ENDPOINT`.
 */
export function initializeTracing(): void {
  if (process.env['NODE_ENV'] === 'test') {
    return
  }

  const exporter = new OTLPTraceExporter({
    url:
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
      'http://localhost:4318/v1/traces',
  })

  sdk = new NodeSDK({
    serviceName: 'payment-orchestrator',
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations()],
  })

  // start() é síncrono em @opentelemetry/sdk-node@0.47.x
  sdk.start()
}

/**
 * Encerra o SDK de tracing graciosamente — drena spans pendentes.
 *
 * Deve ser chamado no handler de SIGTERM / SIGINT (ADR-013).
 * Retorna Promise<void> resolvida imediatamente se o tracing não foi
 * inicializado.
 */
export function shutdownTracing(): Promise<void> {
  return sdk !== null ? sdk.shutdown() : Promise.resolve()
}
