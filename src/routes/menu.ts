import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { redis, reddit, context } from '@devvit/web/server';
import { executeVoteResult } from '../core/vote';

export const menu = new Hono();

//  START VOTE
// Called when mod clicks "🗳️ Start Mod Vote" on a post.
// Checks for existing vote, then shows the config form.
menu.post('/start-vote', async (c) => {
    const request = await c.req.json<MenuItemRequest>();
    const postId = request.targetId;

    // Block duplicate votes on the same post
    const existingMeta = await redis.get(`vote:${postId}:meta`);
    if (existingMeta) {
        const meta = JSON.parse(existingMeta);
        if (meta.status === 'open') {
            return c.json<UiResponse>(
                { showToast: '⚠️ A vote is already open on this post.' },
                200
            );
        }
    }

    // Return the vote config form — Devvit renders this natively
    return c.json<UiResponse>(
        {
            showForm: {
                name: 'startVote',
                form: {
                    title: 'Start Mod Vote',
                    acceptLabel: 'Start Vote',
                    cancelLabel: 'Cancel',
                    fields: [
                        {
                            // Hidden field — carries postId through to the form handler
                            name: 'postId',
                            label: 'Post ID',
                            type: 'string',
                            defaultValue: postId,
                            required: true,
                            hidden: true,
                        },
                        {
                            name: 'reason',
                            label: 'Reason for vote',
                            type: 'string',
                            required: true,
                            placeholder:
                                'e.g. Possible spam, borderline rule 3 violation',
                        },
                        {
                            // Duration in hours — converted to a deadline timestamp in the handler
                            name: 'duration',
                            label: 'Duration (hours)',
                            type: 'number',
                            defaultValue: 24,
                            required: true,
                        },
                        {
                            name: 'quorum',
                            label: 'Quorum (min votes needed)',
                            type: 'number',
                            defaultValue: 2,
                            required: true,
                        },
                        {
                            // When true, individual choices are hidden from other mods
                            name: 'anonymous',
                            label: 'Anonymous voting',
                            type: 'boolean',
                            defaultValue: true,
                            helpText: 'Hide individual votes from other mods',
                        },
                    ],
                },
            },
        },
        200
    );
});

//  CAST VOTE
// Called when mod clicks "🗳️ Cast My Vote" on a post.
// Validates the vote is open, then shows the voting form.
menu.post('/cast-vote', async (c) => {
    const request = await c.req.json<MenuItemRequest>();
    const postId = request.targetId;

    const metaRaw = await redis.get(`vote:${postId}:meta`);
    if (!metaRaw) {
        return c.json<UiResponse>(
            { showToast: 'No active vote on this post.' },
            200
        );
    }

    const meta = JSON.parse(metaRaw);

    //  Send reminder if within 2 hours of deadline and quorum not met
    const twoHours = 2 * 60 * 60 * 1000;
    const timeLeft = meta.deadline - Date.now();
    if (meta.status === 'open' && timeLeft > 0 && timeLeft <= twoHours) {
        const votersRaw = await redis.get(`vote:${postId}:voters`);
        const voters: string[] = votersRaw ? JSON.parse(votersRaw) : [];
        if (voters.length < meta.quorum) {
            const reminderSent = await redis.get(`vote:${postId}:reminder`);
            if (!reminderSent) {
                await redis.set(`vote:${postId}:reminder`, '1');
                const minutesLeft = Math.round(timeLeft / 60000);
                try {
                    await reddit.sendPrivateMessage({
                        to: `/r/${meta.subredditName}`,
                        subject: `[Mod Vote Reminder] ${meta.reason}`,
                        text: [
                            `⏰ **Reminder: Mod vote closing in ${minutesLeft} minutes**`,
                            ``,
                            `**Reason:** ${meta.reason}`,
                            `**Votes cast:** ${voters.length}/${meta.quorum} required`,
                            ``,
                            `Quorum not reached yet. Please vote before the deadline.`,
                            ``,
                            `Go to the post → tap ••• → Cast My Vote`,
                        ].join('\n'),
                    });
                } catch (e) {
                    console.error('Reminder modmail failed:', e);
                }
            }
        }
    }

    // Auto-expire votes that have passed their deadline
    if (meta.status === 'open' && Date.now() > meta.deadline) {
        await executeVoteResult(postId, meta);
        return c.json<UiResponse>(
            {
                showToast:
                    '⏰ Vote deadline passed — results have been posted to modmail.',
            },
            200
        );
    }

    if (meta.status !== 'open') {
        return c.json<UiResponse>(
            { showToast: `This vote is ${meta.status}.` },
            200
        );
    }

    // Check if this mod already voted
    const votersRaw = await redis.get(`vote:${postId}:voters`);
    const voters: string[] = votersRaw ? JSON.parse(votersRaw) : [];
    if (context.username && voters.includes(context.username)) {
        // Show current tally if already voted
        const tallyRaw = await redis.get(`vote:${postId}:tally`);
        const tally = tallyRaw
            ? JSON.parse(tallyRaw)
            : { remove: 0, keep: 0, discuss: 0 };
        return c.json<UiResponse>(
            {
                showToast: `You already voted. Current tally — Remove: ${tally.remove} | Keep: ${tally.keep} | Discuss: ${tally.discuss}`,
            },
            200
        );
    }

    return c.json<UiResponse>(
        {
            showForm: {
                name: 'castVote',
                form: {
                    title: 'Cast Your Vote',
                    acceptLabel: 'Submit Vote',
                    cancelLabel: 'Cancel',
                    fields: [
                        {
                            // Hidden — carries postId through to the form handler
                            name: 'postId',
                            label: 'Post ID',
                            type: 'string',
                            defaultValue: postId,
                            required: true,
                            helpText: 'Auto-filled.',
                        },
                        {
                            name: 'choice',
                            label: 'Your decision',
                            // @ts-ignore — select type is valid but typedefs may lag
                            type: 'select',
                            options: [
                                {
                                    label: '🚫 Remove this post',
                                    value: 'remove',
                                },
                                { label: '✅ Keep this post', value: 'keep' },
                                {
                                    label: '💬 Needs discussion',
                                    value: 'discuss',
                                },
                            ],
                            required: true,
                        },
                    ],
                },
            },
        },
        200
    );
});

//  CLOSE VOTE (MANUAL)
// Allows a mod to force-close a vote early and execute the result.
// Useful for testing and for time-sensitive decisions.
menu.post('/close-vote', async (c) => {
    const request = await c.req.json<MenuItemRequest>();
    const postId = request.targetId;

    const metaRaw = await redis.get(`vote:${postId}:meta`);
    if (!metaRaw) {
        return c.json<UiResponse>(
            { showToast: 'No vote found on this post.' },
            200
        );
    }

    const meta = JSON.parse(metaRaw);
    if (meta.status !== 'open') {
        return c.json<UiResponse>(
            { showToast: 'This vote is already closed.' },
            200
        );
    }

    await executeVoteResult(postId, meta);

    return c.json<UiResponse>(
        { showToast: '✅ Vote closed. Results posted to modmail.' },
        200
    );
});

// VOTE HISTORY
// Subreddit-level menu item — shows all past votes as a modmail summary.
// Reads the history list from Redis and fetches meta for each vote.
menu.post('/vote-history', async (c) => {
    const subredditName = context.subredditName ?? '';

    const historyRaw = await redis.get(`history:${subredditName}`);
    const history: string[] = historyRaw ? JSON.parse(historyRaw) : [];

    if (history.length === 0) {
        return c.json<UiResponse>(
            { showToast: 'No vote history found for this subreddit.' },
            200
        );
    }

    const recentHistory = history.slice(0, 10);
    const totalCount = history.length;
    const showingCount = recentHistory.length;

    const lines: string[] = [
        `**Mod Vote History — r/${subredditName}**`,
        `Showing ${showingCount} of ${totalCount} votes`,
        ``,
    ];

    for (const postId of recentHistory) {
        const metaRaw = await redis.get(`vote:${postId}:meta`);
        if (!metaRaw) continue;

        const meta = JSON.parse(metaRaw);
        const tallyRaw = await redis.get(`vote:${postId}:tally`);
        const tally = tallyRaw
            ? JSON.parse(tallyRaw)
            : { remove: 0, keep: 0, discuss: 0 };

        // Format outcome emoji
        const outcomeEmoji =
            meta.action === 'remove'
                ? '🚫 Removed'
                : meta.action === 'keep'
                  ? '✅ Kept'
                  : meta.action === 'discuss'
                    ? '💬 Discuss'
                    : meta.action === 'tie'
                      ? '🤝 Tie'
                      : meta.status === 'inconclusive'
                        ? '⚠️ Inconclusive'
                        : '🔄 Open';

        // Format created date
        const createdAt = meta.createdAt
            ? new Date(meta.createdAt).toUTCString()
            : 'Unknown date';

        // Format time remaining for open votes
        let timeInfo = '';
        if (meta.status === 'open') {
            const timeLeft = meta.deadline - Date.now();
            if (timeLeft <= 0) {
                timeInfo = '⏰ Deadline passed — awaiting close';
            } else {
                const hours = Math.floor(timeLeft / (1000 * 60 * 60));
                const minutes = Math.floor(
                    (timeLeft % (1000 * 60 * 60)) / (1000 * 60)
                );
                timeInfo =
                    hours > 0
                        ? `Closes in ${hours}h ${minutes}m`
                        : `Closes in ${minutes}m`;
            }
        }

        const postUrl = `https://www.reddit.com/r/${subredditName}/comments/${postId.replace('t3_', '')}`;

        lines.push(`**${meta.reason}**`);
        lines.push(`Created: ${createdAt}`);
        lines.push(
            `Outcome: ${outcomeEmoji} | Remove: ${tally.remove} | Keep: ${tally.keep} | Discuss: ${tally.discuss}`
        );
        lines.push(`Started by: u/${meta.createdBy} | [View Post](${postUrl})`);

        // Show time remaining for open votes
        if (timeInfo) {
            lines.push(timeInfo);
        }

        // Show individual choices for closed named votes
        if (!meta.anonymous && meta.status === 'closed') {
            const choicesRaw = await redis.get(`vote:${postId}:choices`);
            if (choicesRaw) {
                const choices: Record<string, string> = JSON.parse(choicesRaw);
                const choiceLines = Object.entries(choices).map(
                    ([mod, choice]) =>
                        `u/${mod}: ${
                            choice === 'remove'
                                ? '🚫 Remove'
                                : choice === 'keep'
                                  ? '✅ Keep'
                                  : '💬 Discuss'
                        }`
                );
                if (choiceLines.length > 0) {
                    lines.push(`Individual votes: ${choiceLines.join(', ')}`);
                }
            }
        }

        lines.push(`---`);
    }

    try {
        await reddit.sendPrivateMessage({
            to: `/r/${subredditName}`,
            subject: `[Mod Vote History] r/${subredditName} — ${totalCount} vote${totalCount !== 1 ? 's' : ''}`,
            text: lines.join('\n'),
        });
    } catch (e) {
        console.error('History modmail failed:', e);
        return c.json<UiResponse>(
            { showToast: '❌ Failed to send history.' },
            200
        );
    }

    return c.json<UiResponse>(
        { showToast: `📋 Vote history sent to modmail (${totalCount} votes).` },
        200
    );
});
