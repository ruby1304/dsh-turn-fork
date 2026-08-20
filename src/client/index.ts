/**
 * Browser half of Turn Fork: Timeline view, compact header controls, and
 * per-assistant-message actions — all through official slots, no DOM
 * injection. Copy ships through the `turn-fork` locale namespace (zh/en);
 * without the locale service the controller falls back to the English
 * dictionary through a local template interpolator.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TURN_FORK_VIEW_ORDER, type TurnForkLocaleKey } from '../shared.ts'
import { TurnForkController } from './controller.ts'
import { TURN_FORK_EN, TURN_FORK_ZH } from './locales.ts'
import { TurnForkTimelineView } from './TurnForkTimelineView.tsx'
import { TurnForkHeaderActions } from './TurnForkHeaderActions.tsx'
import { AssistantMessageActions } from './AssistantMessageActions.tsx'

export const inject = ['slots', 'conversation', 'connection', 'sessions']

function templateFallback(template: string, params?: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (
    params === undefined || params[name] === undefined ? `{${name}}` : String(params[name])
  ))
}

/** Register both UI contributions over one per-session controller identity. */
export function apply(ctx: ClientContext): void {
  const locale = ctx.get('locale')
  const t: Translate<TurnForkLocaleKey> = locale !== undefined
    ? locale.bind('turn-fork')
    : (key, params) => templateFallback(TURN_FORK_EN[key], params)

  if (locale !== undefined) {
    ctx.effect(() => locale.register('turn-fork', {
      zh: TURN_FORK_ZH,
      en: TURN_FORK_EN,
    }), 'turn-fork: locale dictionaries')
  }

  const controllers = new Map<SessionId, TurnForkController>()
  const controllerFor = (sessionId: SessionId): TurnForkController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new TurnForkController(ctx, sessionId, t)
      controllers.set(sessionId, controller)
    }
    return controller
  }

  ctx.on('connection/reset', () => {
    for (const controller of controllers.values()) controller.refreshIfLoaded()
  })

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'turn-fork-timeline',
    order: TURN_FORK_VIEW_ORDER,
    label: () => t('viewLabel'),
    ...locale === undefined ? {} : { locale: 'turn-fork' as const },
    inject: (sessionId: SessionId) => controllerFor(sessionId).face,
  }, TurnForkTimelineView))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'turn-fork-controls',
    order: TURN_FORK_VIEW_ORDER,
    ...locale === undefined ? {} : { locale: 'turn-fork' as const },
    inject: (sessionId: SessionId) => controllerFor(sessionId).face,
  }, TurnForkHeaderActions))

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'turn-fork-assistant-actions',
    order: 100,
    ...locale === undefined ? {} : { locale: 'turn-fork' as const },
    inject: (sessionId: SessionId) => controllerFor(sessionId).face,
  }, AssistantMessageActions))
}
