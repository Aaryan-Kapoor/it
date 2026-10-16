import { useSession } from './session'

/** This warning stays outside query error boundaries, so a failed page can still explain it. */
export function ServiceNotice() {
  const { service, role } = useSession()
  if (service?.functions !== 'retained') return null
  return (
    <p className="notice" role="status">
      <span>
        It is using older backend functions. Some pages or controls may not work.
        {role === 'owner' ? (
          <>
            {' '}
            Run <code>it status</code> on the machine It runs on for the reason. <code>it service logs</code> shows what the service met. After resolving the
            reported problem, restart It to retry.
          </>
        ) : (
          ' Open It in your owner browser for recovery steps.'
        )}
      </span>
    </p>
  )
}
