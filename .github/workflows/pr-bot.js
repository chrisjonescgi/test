const http = require('https');
const fs = require('fs');

// Env variables
const slackBotToken = process.env.SLACK_BOT_TOKEN;
const slackChannel = process.env.SLACK_CHANNEL;
const slackChannelId = process.env.SLACK_CHANNEL_ID;
const githubToken = process.env.GH_TOKEN;

// Validate environment variables
if (!slackBotToken || !slackChannel || !slackChannelId || !githubToken) {
  console.error('Missing required environment variables');
  process.exit(1);
}

// Load event data
let eventData;
try {
  eventData = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
} catch (error) {
  console.error('Failed to parse GITHUB_EVENT_PATH:', error.message);
  process.exit(1);
}
console.log('eventData: ', eventData);
const prAction = eventData.action;
const prNumber = eventData.pull_request.number;
const prAuthor = eventData.pull_request.user.login;
const prTitle = eventData.pull_request.title;
const repo = eventData.repository.full_name;
const reviewState = eventData.review ? eventData.review.state : '';
const prLink = `https://github.com/${repo}/pull/${prNumber}`;

console.log('Environment variables and event data:');
console.log({ slackChannel, prAction, prNumber, repo, reviewState });

async function makeRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(new Error(`Failed to parse response: ${error.message}`));
            }
          });
        });
        req.on('error', (error) => reject(new Error(`Request error: ${error.message}`)));
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
    try {
        const reviews = await makeRequest(options);
        return reviews.filter((review) => review.state === 'APPROVED').length;
    } catch (error) {
        console.error('Failed to get PR approvals:', error.message);
        throw error;
    }
}

async function postSlackMessage(text, channel) {
    const options = {
        hostname: 'slack.com',
        path: '/api/chat.postMessage',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${slackBotToken}`,
            'Content-Type': 'application/json'
        }
    };
    try {
        const response = await makeRequest(options, { channel, text });
        if (!response.ok) {
            throw new Error(`Slack API error: ${response.error}`);
        }
        return response.ts;
    } catch (error) {
        console.error('Failed to post Slack message:', error.message);
        throw error;
    }
}

async function updateSlackMessage(ts, text, channel) {
    const options = {
        hostname: 'slack.com',
        path: '/api/chat.update',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${slackBotToken}`,
            'Content-Type': 'application/json'
        }
    };
    try {
        const response = await makeRequest(options, { channel, ts, text });
        if (!response.ok) {
            throw new Error(`Slack API error: ${response.error}`);
        }
    } catch (error) {
        console.error('Failed to update Slack message:', error.message);
        throw error;
    }
}

async function deleteSlackMessage(ts, channel) {
     const options = {
        hostname: 'slack.com',
        path: '/api/chat.delete',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${slackBotToken}`,
            'Content-Type': 'application/json'
        }
    };
    try {
        const response = await makeRequest(options, { channel, ts });
        if (!response.ok) {
            throw new Error(`Slack API error: ${response.error}`);
        }
    } catch (error) {
        console.error('Failed to delete Slack message:', error.message);
        throw error;
    }
}

async function getSlackMessageTimestamp() {
  const commentsOptions = {
    hostname: 'api.github.com',
    path: `/repos/${repo}/issues/${prNumber}/comments`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Node.js',
    },
  };
  try {
    const comments = await makeRequest(commentsOptions);
    if (!Array.isArray(comments)) {
      console.error('Unexpected GitHub API response: comments is not an array', comments);
      throw new Error('GitHub API did not return an array of comments');
    }
    const tsComment = comments.find((c) => c.body.startsWith('SLACK_MESSAGE_TS:'));
    if (!tsComment) {
      console.error('No Slack message timestamp found in PR comments');
      return null;
    }
    return tsComment.body.split(':')[1];
  } catch (error) {
    console.error('Failed to get Slack message timestamp:', error.message);
    throw error;
  }
}

async function main() {
    if (!prNumber || !repo) {
        console.error('Invalid PR data:', { prNumber, repo });
        return;
    }
    
    const prMessage = `(0 of 2 approvals) PR #${prNumber} by ${prAuthor}:\n<${prLink}|${prTitle}>\n---`;

    try {
        if (prAction === 'opened') {
            console.log('Posting initial Slack message for PR:', prNumber);
            const ts = await postSlackMessage(prMessage, slackChannel);
            const commentOptions = {
                hostname: 'api.github.com',
                path: `/repos/${repo}/issues/${prNumber}/comments`,
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${githubToken}`,
                    Accept: 'application/vnd.github.v3+json',
                    'User-Agent': 'Node.js',
                },
            };
            await makeRequest(commentOptions, { body: `SLACK_MESSAGE_TS:${ts}` });
            console.log('Posted Slack message and stored timestamp:', ts);
        } else if (prAction === 'submitted' && reviewState === 'approved') {
            console.log('Processing review for PR:', prNumber);
            const approvals = await getPRApprovals();
            console.log('Current approvals:', approvals);

            const ts = await getSlackMessageTimestamp();
            if (!ts) {
              console.log('No Slack message to update/delete');
              return;
            }
    
            if (approvals === 1) {
                console.log('Updating Slack message to 1/2 approvals');
                await updateSlackMessage(ts, `(1 of 2 approvals) PR #${prNumber} by ${prAuthor}:\n<${prLink}|${prTitle}>\n---`, slackChannelId);
            } else if (approvals >= 2) {
                console.log('Deleting Slack message due to 2+ approvals');
                await deleteSlackMessage(ts, slackChannelId);
            }
        } else if (prAction === 'closed') { 
          console.log('PR closed, attempting to delete Slack message for PR:', prNumber);
          const ts = await getSlackMessageTimestamp();
          if (!ts) {
            console.log('No Slack message to delete');
            return;
          }
          console.log('Deleting Slack message with timestamp:', ts);
          await deleteSlackMessage(ts, slackChannelId);
          console.log('Slack message deleted successfully');
        } else {
            console.log('No action required for event:', prAction);
        }
    } catch (error) {
        console.error('Main function error:', error.message);
        process.exit(1);
    }
}

main();
