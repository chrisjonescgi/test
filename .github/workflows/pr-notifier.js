const http = require('https');

// Env variables
const slackBotToken = process.env.SLACK_BOT_TOKEN;
const slackChannel = process.env.SLACK_CHANNEL;
const githubToken = process.env.GH_TOKEN;
const prAction = process.env.GITHUB_EVENT_ACTION;
const prNumber = process.env.GITHUB_PULL_REQUEST_NUMBER;
const repo = process.env.GITHUB_REPOSITORY;
const reviewState = process.env.GITHUB_REVIEW_STATE || '';

async function makeRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function getPRApprovals() {
    const options = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/pulls/${prNumber}/reviews`,
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Node.js'
        }
    };
    const reviews = await makeRequest(options);
    return reviews.filter(review => review.state === 'APPROVED').length;
}

async function postSlackMessage(text, chanel) {
    const options = {
        hostname: 'slack.com',
        path: '/api.chat.postMessage',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${slackBotToken}`,
            'Content-Type': 'application/json'
        }
    };
    const reponse = await makeRequest(options, { channel, text });
    return response.ts;
}

async function updateSlackMessage(ts, text, channel) {
    const options = {
        hostname: 'slack.com',
        path: '/api.chat.update',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${slackBotToken}`,
            'Content-Type': 'application/json'
        }
    };
    await makeRequest(options, { channel, ts, text });
}

async function deleteSlackMessage(ts, channel) {
     const options = {
        hostname: 'slack.com',
        path: '/api.chat.delete',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${slackBotToken}`,
            'Content-Type': 'application/json'
        }
    };
    await makeRequest(options, { channel, ts });
}

async function main() {
    const prLink = `https://github.com/${repo}/pull/${prNumber}`;
    const prMessage = `(0/2 approvals) PR: ${prLink}`;

    if (prAction === 'opened') {
        // post initial message in slack
        const ts = await postSlackMessage(prMessage, slackChannel);
        // store timestamp in PR comment (to be used for updated message approval count prefix later)
        const commentOptions = {
            hostname: 'api.github.com',
            path: `/repos/${repo}/issues/${prNumber}/comments`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Node.js'
            }
        };
        await makeRequest(commentOptions, { body: `SLACK_MESSAGE_TS:${ts}` });
    } else if (prAction === 'submitted' && reviewState === 'approved') {
        // get current approval count
        const approvals = await getPRApprovals();
        // get stored slack message timestamp from PR comment
        const commentsOptions = {
            hostname: 'api/github.com',
            path: `/repos/${repo}/issues/${prNumber}/comments`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Node.js'
            }
        };
        const comments = await makeRequest(commentOptions);
        const tsComment = comments.find(c => c.body.startsWith('SLACK_MESSAGE_TS:'));
        if (!tsComment) return;

        const ts = tsComment.body.split(':')[1];
        if (approvals === 1) {
            // update message to 1/2 approvals
            await updateSlackMessage(ts, `(1/2 approvals) PR: ${prLink}`, slackChannel);
        } else if (approvals >= 2) {
            // remove message from channel when 2 approvals met
            await deleteSlackMessage(ts, slackChannel);
        }
    }
}

main().catch(console.error);