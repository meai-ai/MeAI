/**
 * Datetime skill — returns current local time, date, weekday, and timezone.
 * No external API needed; uses the system clock of the machine running MeAI.
 */

export function getTools(_config?: any): any[] {
  return [
    {
      name: 'get_current_time',
      description:
        'Get the current date and time. ' +
        'Use this whenever the user asks what time or date it is, ' +
        'or when any task needs to know the current time (e.g. checking calendar, logging, scheduling). ' +
        'Always pass the timezone configured for this character (typically "America/Los_Angeles") unless the user explicitly asks about a different timezone.',
      inputSchema: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description:
              'IANA timezone name to format the time in, e.g. "America/Los_Angeles" or "Asia/Shanghai". ' +
              'Defaults to the system local timezone if omitted.',
          },
        },
        required: [],
      },
      execute: async (args: any): Promise<string> => {
        const now = new Date();

        try {
          const tz = (args.timezone as string | undefined) || 'America/Los_Angeles';
          const locale = 'zh-CN';

          const formatted = now.toLocaleString(locale, {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            weekday: 'long',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });

          // Resolve the actual timezone name used
          const resolvedTz = tz;

          return JSON.stringify({
            success: true,
            iso: now.toISOString(),
            formatted,
            timezone: resolvedTz,
            unix: Math.floor(now.getTime() / 1000),
          });
        } catch (err: any) {
          // If an invalid timezone was given, fall back to system local
          const formatted = now.toLocaleString('zh-CN', {
            timeZone: 'America/Los_Angeles',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            weekday: 'long',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });

          return JSON.stringify({
            success: true,
            iso: now.toISOString(),
            formatted,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            unix: Math.floor(now.getTime() / 1000),
            warning: `Invalid timezone "${args.timezone}", fell back to system local.`,
          });
        }
      },
    },
  ];
}
