import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "process scheduled publishes",
  { minutes: 1 },
  internal.videos.processDueSchedules,
);

// Every 6 hours: verify OAuth tokens for all YouTube-connected users.
crons.interval(
  "check youtube oauth health",
  { hours: 6 },
  internal.actions.oauthHealthCheck.checkAllUsersOAuthHealth,
);

// Every Sunday at 08:00 UTC: send weekly digest notifications.
// TODO(email agent): uncomment once internal.actions.email.sendWeeklyDigestToAll is implemented.
// crons.weekly(
//   "weekly digest notifications",
//   { dayOfWeek: "sunday", hourUTC: 8, minuteUTC: 0 },
//   internal.actions.email.sendWeeklyDigestToAll,
// );

export default crons;
