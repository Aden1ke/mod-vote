import { redis, reddit } from '@devvit/web/server';

//  VoteMeta type
export type VoteMeta = {
    reason: string;
    createdBy: string;
    deadline: number;
    anonymous: boolean;
    quorum: number;
    status: string;
    postId: string;
    subredditName: string;
    action?: string;
};

//  executeVoteResult
// Core function that closes a vote, determines the winner,
// executes the action (remove/keep/discuss), and posts results to modmail.
// Called by: manual close menu, auto-expire on vote/cast-vote check.
export async function executeVoteResult(
    postId: string,
    meta: VoteMeta
): Promise<void> {
    // Guard: only process open votes
    if (meta.status !== 'open') return;

    const tallyRaw = await redis.get(`vote:${postId}:tally`);
    const tally: Record<string, number> = tallyRaw
        ? JSON.parse(tallyRaw)
        : { remove: 0, keep: 0, discuss: 0 };

    const totalVotes =
        (tally.remove ?? 0) + (tally.keep ?? 0) + (tally.discuss ?? 0);

    let status: string;
    let action: string;
    let resultMessage: string;

    if (totalVotes < meta.quorum) {
        //  Quorum not reached — no automatic action
        status = 'inconclusive';
        action = 'none';
        resultMessage = [
            `**Vote closed — Inconclusive ⚠️**`,
            ``,
            `Quorum not reached: ${totalVotes}/${meta.quorum} votes cast`,
            ``,
            `Remove: ${tally.remove} | Keep: ${tally.keep} | Discuss: ${tally.discuss}`,
            ``,
            `No automatic action taken.`,
            ``,
            `u/${meta.createdBy} please make a final call on this vote or restart it with a longer deadline.`,
        ].join('\n');
    } else {
        //  Quorum reached → find the winner
        const max = Math.max(
            tally.remove ?? 0,
            tally.keep ?? 0,
            tally.discuss ?? 0
        );

        // Count how many options tied for the top
        const topOptions = ['remove', 'keep', 'discuss'].filter(
            (opt) => (tally[opt] ?? 0) === max
        );

        if (topOptions.length > 1) {
            // Tie — no automatic action
            status = 'inconclusive';
            action = 'tie';
            resultMessage = [
                `**Vote closed — TIE 🤝**`,
                ``,
                `Remove: ${tally.remove} | Keep: ${tally.keep} | Discuss: ${tally.discuss}`,
                ``,
                `No automatic action taken due to tied result. Mods should decide manually.`,
            ].join('\n');
        } else if (tally.remove === max) {
            // Remove wins
            status = 'closed';
            action = 'remove';
            resultMessage = [
                `**Vote closed — REMOVE 🚫**`,
                ``,
                `Remove: ${tally.remove} | Keep: ${tally.keep} | Discuss: ${tally.discuss}`,
                ``,
                `Post has been removed automatically.`,
            ].join('\n');

            try {
                // Remove the post (false = not spam)
                await reddit.remove({ id: postId, spam: false });
            } catch (e) {
                console.error('Failed to remove post:', e);
                // Still send results even if remove fails
            }
        } else if ((tally.keep ?? 0) >= max) {
            // Keep wins
            status = 'closed';
            action = 'keep';
            resultMessage = [
                `**Vote closed — KEEP ✅**`,
                ``,
                `Remove: ${tally.remove} | Keep: ${tally.keep} | Discuss: ${tally.discuss}`,
                ``,
                `Post will remain up.`,
            ].join('\n');
        } else {
            // Discuss wins or tie
            status = 'closed';
            action = 'discuss';
            resultMessage = [
                `**Vote closed — NEEDS DISCUSSION 💬**`,
                ``,
                `Remove: ${tally.remove} | Keep: ${tally.keep} | Discuss: ${tally.discuss}`,
                ``,
                `No automatic action. Mods should discuss further.`,
            ].join('\n');
        }
    }

    //  Persist updated status
    meta.status = status;
    meta.action = action;
    await redis.set(`vote:${postId}:meta`, JSON.stringify(meta));

    //  Send results to modmail
    //  Add named votes to results if not anonymous
    if (!meta.anonymous) {
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
                resultMessage +=
                    '\n\n**Individual votes:**\n' + choiceLines.join('\n');
            }
        }
    }
    const postUrl = `https://www.reddit.com/r/${meta.subredditName}/comments/${postId.replace('t3_', '')}`;
    try {
        await reddit.sendPrivateMessage({
            to: `/r/${meta.subredditName}`,
            subject: `[Mod Vote Results] ${meta.reason}`,
            text: [
                resultMessage,
                ``,
                `**Post:** ${postUrl}`,
                `**Reason:** ${meta.reason}`,
                `**Started by:** u/${meta.createdBy}`,
            ].join('\n'),
        });
    } catch (e) {
        console.error('Results modmail failed:', e);
    }
}
