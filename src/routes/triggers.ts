import { Hono } from 'hono';
import type { OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';
import { reddit } from '@devvit/web/server';

export const triggers = new Hono();

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  const subredditName = input.subreddit?.name ?? '';

  console.log('App installed to subreddit: r/' + subredditName);

  // Send welcome modmail to the mod team explaining how to use Mod Vote
  try {
    await reddit.sendPrivateMessage({
      to: `/r/${subredditName}`,
      subject: `Mod Vote has been installed on r/${subredditName}`,
      text: [
        `**Welcome to Mod Vote! 🗳️**`,
        ``,
        `Mod Vote lets your mod team vote on borderline posts privately and asynchronously — no more waiting for everyone to be online at once.`,
        ``,
        `**How to start a vote:**`,
        `1. Go to any post`,
        `2. Tap ••• → **Start Mod Vote**`,
        `3. Fill in the reason, duration, and quorum`,
        `4. All mods are notified via modmail`,
        ``,
        `**How to vote:**`,
        `1. Open the post from the modmail link`,
        `2. Tap ••• → **Cast My Vote**`,
        `3. Choose Remove, Keep, or Needs Discussion`,
        ``,
        `**How votes close:**`,
        `- Automatically when the deadline passes (on next mod interaction)`,
        `- Manually via ••• → **Close Vote Now**`,
        ``,
        `**Vote History:**`,
        `- Tap ••• on the subreddit → **Vote History** to see all past votes`,
        ``,
        `**Settings:**`,
        `- Default duration: 24 hours`,
        `- Default quorum: 2 mods`,
        `- Anonymous voting: on by default`,
        ``,
        `Happy moderating! 🛡️`,
      ].join('\n'),
    });
  } catch (e) {
    console.error('Welcome modmail failed:', e);
  }

  return c.json<TriggerResponse>(
    { status: 'success' },
    200
  );
});
