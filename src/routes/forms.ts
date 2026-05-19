import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { redis, reddit, context } from '@devvit/web/server';
import { executeVoteResult } from '../core/vote';

export const forms = new Hono();

//  START VOTE SUBMIT 
// Runs when mod submits the Start Mod Vote form.
// Writes vote data to Redis and notifies all mods via modmail.
forms.post('/start-vote-submit', async (c) => {
  const values = await c.req.json<{
    postId: string;
    reason: string;
    duration: number;
    quorum: number;
    anonymous: boolean;
  }>();

  const { postId, reason, duration, quorum, anonymous } = values;

  if (!postId || !reason) {
    return c.json<UiResponse>(
      { showToast: '❌ Missing required fields.' },
      200
    );
  }

  // Calculate deadline timestamp from duration in hours
  const durationHours = Number(duration) || 24;
  const deadline = Date.now() + durationHours * 60 * 60 * 1000;
  const createdBy = context.username ?? 'unknown';
  const subredditName = context.subredditName ?? '';

  //  Write vote state to Redis 
  // meta: all vote config + current status
  const meta = {
    reason,
    createdBy,
    deadline,
    anonymous: Boolean(anonymous),
    quorum: Number(quorum) || 2,
    status: 'open', // open | closed | inconclusive
    postId,
    subredditName,
  };
  await redis.set(`vote:${postId}:meta`, JSON.stringify(meta));

  // tally: vote counts per option — updated on each cast vote
  await redis.set(
    `vote:${postId}:tally`,
    JSON.stringify({ remove: 0, keep: 0, discuss: 0 })
  );

  // voters: list of usernames — prevents double voting
  await redis.set(`vote:${postId}:voters`, JSON.stringify([]));

  // history: ordered list of all vote postIds for this subreddit
  const historyRaw = await redis.get(`history:${subredditName}`);
  const history: string[] = historyRaw ? JSON.parse(historyRaw) : [];
  history.unshift(postId); // newest first
  await redis.set(`history:${subredditName}`, JSON.stringify(history));

  //  Notify all mods via modmail 
  // Sending to /r/subredditName goes to the mod team inbox
  const deadlineStr = new Date(deadline).toUTCString();
  const postUrl = `https://www.reddit.com/r/${subredditName}/comments/${postId.replace('t3_', '')}`;

  try {
    await reddit.sendPrivateMessage({
      to: `/r/${subredditName}`,
      subject: `[Mod Vote] ${reason}`,
      text: [
        `**Mod vote started by u/${createdBy}**`,
        ``,
        `**Post:** ${postUrl}`,
        `**Reason:** ${reason}`,
        `**Deadline:** ${deadlineStr}`,
        `**Quorum:** ${quorum} votes required`,
        `**Anonymous:** ${anonymous ? 'Yes' : 'No'}`,
        ``,
        `**To vote:** Go to the post → click ••• → select "🗳️ Cast My Vote"`,
        ``,
        `The vote will execute automatically when closed.`,
      ].join('\n'),
    });
  } catch (e) {
    console.error('Modmail failed:', e);
    // Don't fail the whole operation if modmail has an issue
  }

  return c.json<UiResponse>(
    { showToast: '✅ Vote started! All mods notified via modmail.' },
    200
  );
});

//  CAST VOTE SUBMIT 
// Runs when a mod submits their vote choice.
// Updates Redis tally and records the voter.
forms.post('/cast-vote-submit', async (c) => {
  const values = await c.req.json<{
    postId: string;
    choice: string | string[];
  }>();

  const postId = values.postId;
  // choice may come as array from select field
  const choice = Array.isArray(values.choice)
    ? values.choice[0]
    : values.choice;

  if (!postId || !choice) {
    return c.json<UiResponse>(
      { showToast: '❌ Missing vote data.' },
      200
    );
  }

  //  Validate vote is still open 
  const metaRaw = await redis.get(`vote:${postId}:meta`);
  if (!metaRaw) {
    return c.json<UiResponse>(
      { showToast: 'No active vote found on this post.' },
      200
    );
  }

  const meta = JSON.parse(metaRaw);

  // Auto-expire if past deadline
  if (meta.status === 'open' && Date.now() > meta.deadline) {
    await executeVoteResult(postId, meta);
    return c.json<UiResponse>(
      { showToast: '⏰ Vote deadline passed — results posted to modmail.' },
      200
    );
  }

  if (meta.status !== 'open') {
    return c.json<UiResponse>(
      { showToast: 'This vote is already closed.' },
      200
    );
  }

  //  Prevent double voting 
  const votersRaw = await redis.get(`vote:${postId}:voters`);
  const voters: string[] = votersRaw ? JSON.parse(votersRaw) : [];
  const username = context.username ?? '';

  if (voters.includes(username)) {
    return c.json<UiResponse>(
      { showToast: 'You have already voted on this post.' },
      200
    );
  }

  //  Update tally 
  const tallyRaw = await redis.get(`vote:${postId}:tally`);
  const tally: Record<string, number> = tallyRaw
    ? JSON.parse(tallyRaw)
    : { remove: 0, keep: 0, discuss: 0 };

  if (choice in tally) {
    tally[choice]++;
  }
  await redis.set(`vote:${postId}:tally`, JSON.stringify(tally));

  //  Record voter 
  voters.push(username);
  await redis.set(`vote:${postId}:voters`, JSON.stringify(voters));

  //  Record individual choice (named mode only) 
  // In anonymous mode we only know WHO voted, not what they chose.
  if (!meta.anonymous && username) {
    const choicesRaw = await redis.get(`vote:${postId}:choices`);
    const choices: Record<string, string> = choicesRaw
      ? JSON.parse(choicesRaw)
      : {};
    choices[username] = choice;
    await redis.set(`vote:${postId}:choices`, JSON.stringify(choices));
  }

  const label =
    choice === 'remove' ? '🚫 Remove' :
    choice === 'keep'   ? '✅ Keep'   : '💬 Discuss';

  return c.json<UiResponse>(
    {
      showToast: `Vote cast: ${label} — Remove: ${tally.remove} | Keep: ${tally.keep} | Discuss: ${tally.discuss}`,
    },
    200
  );
});
