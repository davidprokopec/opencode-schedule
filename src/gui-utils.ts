// Whole seconds rounded to the nearest second, then whole minutes truncated:
// never shows more time than is left (no "1h 1m" for a fresh 1h wait, and no
// "60m" remainder).
export function remaining(firesAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((firesAt - now) / 1000))
  if (seconds < 60) return `in ${seconds}s`
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `in ${hours}h${minutes ? ` ${minutes}m` : ""}`
}

// Host RPC failures arrive as plain `{ type, message, data }` objects, not
// Error instances, so read a string `message` from either shape.
export function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error) return cause.message || fallback
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const { message } = cause
    if (typeof message === "string" && message) return message
  }
  return fallback
}

export function parseWaitArguments(raw: string): { duration: string; prompt: string } | undefined {
  const match = raw.trim().match(/^(\S+)\s+([\s\S]+)$/)
  if (!match) return undefined
  const [, duration, prompt] = match
  if (duration === undefined || prompt === undefined) return undefined
  return { duration, prompt: prompt.trim() }
}

export function createSessionScope() {
  let currentKey: string | undefined
  let generation = 0
  let disposed = false
  return {
    enter(key: string): number {
      if (key !== currentKey) {
        currentKey = key
        generation++
      }
      return generation
    },
    capture(): number {
      return generation
    },
    isCurrent(key: string, token: number): boolean {
      return !disposed && key === currentKey && token === generation
    },
    dispose(): void {
      disposed = true
      generation++
    },
  }
}
