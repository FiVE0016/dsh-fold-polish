import { installLocalConversationDeletion } from './src/delete-host.js'
export const name = 'dsh-fold-polish'

export const inject = []

export function apply(ctx) {
  ctx.inject(
    [
      'sessionPersistence',
      'sessions',
      'agents',
      'workspaceRegistry',
      'typert',
      'agentLoop',
      'sessionController',
      'sessionQuery',
      'storageDomain',
      'sessionProjectionCache',
    ],
    (scope) => {
      installLocalConversationDeletion(scope)
    },
  )
}
