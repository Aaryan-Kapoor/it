import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()
// A click whose connector died goes back in the queue within a minute
crons.interval('requeue expired leases', { minutes: 1 }, internal.delivery.reap, {})
// A click kept before It kept when clicks were made is given the time it arrived as that
crons.interval('date old clicks', { minutes: 1 }, internal.delivery.dateOld, {})
// A message to the content service whose retry was lost is started again
crons.interval('retry content jobs', { minutes: 5 }, internal.content.kick, {})
crons.interval('sweep old records', { hours: 1 }, internal.retention.sweep, {})
export default crons
