const https = require('https');
const fs = require('fs');

const CONFIG = {
  REQUIRED_APPROVALS: 2,
  TITLE_MAX_LENGTH: 60,
  SLACK_API_BASE: 'slack.com',
  GITHUB_API_BASE: 'api.github.com',
  TS_COMMENT_PREFIX: 'SLACK_MESSAGE_TS:'
};

const ENV = {
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackChannel: process.env.SLACK_CHANNEL,
  slackChannelId: process.env.SLACK_CHANNEL_ID,
  githubToken: process.env.GH_TOKEN,
  githubEventPath: process.env.GITHUB_EVENT_PATH
};

function validateEnvironment() {
  const required = ['slackBotToken', 'slackChannel', 'slackChannelId', 'githubToken'];
  const missing = required.filter(key => !ENV[key]);
  
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function loadEventData() {
  try {
    const data = JSON.parse(fs.readFileSync(ENV.githubEventPath, 'utf8'));
    return {
      action: data.action,
      prNumber: data.pull_request?.number,
      prAuthor: data.pull_request?.user?.login,
      prTitle: data.pull_request?.title,
      repo: data.repository?.full_name,
      reviewState: data.review?.state || ''
    };
  } catch (error) {
    console.error('Failed to parse GitHub event:', error.message);
    process.exit(1);
  }
}

async function httpRequest(hostname, path, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method, headers };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${error.message}`));
        }
      });
    });
    
    req.on('error', error => reject(error));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const github = {
  async getReviews(repo, prNumber) {
    const path = `/repos/${repo}/pulls/${prNumber}/reviews`;
    const headers = {
      'Authorization': `Bearer ${ENV.githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node.js'
    };
    
    const reviews = await httpRequest(CONFIG.GITHUB_API_BASE, path, 'GET', headers);
    return reviews.filter(review => review.state === 'APPROVED').length;
  },

  async getComments(repo, prNumber) {
    const path = `/repos/${repo}/issues/${prNumber}/comments`;
    const headers = {
      'Authorization': `Bearer ${ENV.githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node.js'
    };
    
    return await httpRequest(CONFIG.GITHUB_API_BASE, path, 'GET', headers);
  },

  async postComment(repo, prNumber, body) {
    const path = `/repos/${repo}/issues/${prNumber}/comments`;
    const headers = {
      'Authorization': `Bearer ${ENV.githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node.js'
    };
    
    return await httpRequest(CONFIG.GITHUB_API_BASE, path, 'POST', headers, { body });
  },

  async findSlackMessageTimestamp(repo, prNumber) {
    const comments = await github.getComments(repo, prNumber);
    
    if (!Array.isArray(comments)) {
      throw new Error('Invalid GitHub API response: expected array of comments');
    }
    
    const tsComment = comments.find(c => c.body.startsWith(CONFIG.TS_COMMENT_PREFIX));
    return tsComment ? tsComment.body.split(':')[1] : null;
  }
};

const slack = {
  async postMessage(channel, text) {
    const headers = {
      'Authorization': `Bearer ${ENV.slackBotToken}`,
      'Content-Type': 'application/json'
    };
    
    const response = await httpRequest(
      CONFIG.SLACK_API_BASE,
      '/api/chat.postMessage',
      'POST',
      headers,
      { channel, text }
    );
    
    if (!response.ok) {
      throw new Error(`Slack API error: ${response.error}`);
    }
    
    return response.ts;
  },

  async updateMessage(channel, ts, text) {
    const headers = {
      'Authorization': `Bearer ${ENV.slackBotToken}`,
      'Content-Type': 'application/json'
    };
    
    const response = await httpRequest(
      CONFIG.SLACK_API_BASE,
      '/api/chat.update',
      'POST',
      headers,
      { channel, ts, text }
    );
    
    if (!response.ok) {
      throw new Error(`Slack API error: ${response.error}`);
    }
  },

  async deleteMessage(channel, ts) {
    const headers = {
      'Authorization': `Bearer ${ENV.slackBotToken}`,
      'Content-Type': 'application/json'
    };
    
    const response = await httpRequest(
      CONFIG.SLACK_API_BASE,
      '/api/chat.delete',
      'POST',
      headers,
      { channel, ts }
    );
    
    if (!response.ok) {
      throw new Error(`Slack API error: ${response.error}`);
    }
  }
};

function formatPRMessage(prNumber, prAuthor, prTitle, repo, approvalCount) {
  const truncatedTitle = prTitle.length > CONFIG.TITLE_MAX_LENGTH 
    ? prTitle.slice(0, CONFIG.TITLE_MAX_LENGTH) + '…' 
    : prTitle;
  const prLink = `https://github.com/${repo}/pull/${prNumber}`;
  
  return `(${approvalCount} of ${CONFIG.REQUIRED_APPROVALS} approvals) PR #${prNumber} by ${prAuthor}:\n<${prLink}|${truncatedTitle}>\n---`;
}

async function handlePROpened(event) {
  const { prNumber, prAuthor, prTitle, repo } = event;
  const message = formatPRMessage(prNumber, prAuthor, prTitle, repo, 0);
  
  console.log(`Posting initial Slack message for PR #${prNumber}`);
  const messageTs = await slack.postMessage(ENV.slackChannel, message);
  
  await github.postComment(repo, prNumber, `${CONFIG.TS_COMMENT_PREFIX}${messageTs}`);
  console.log(`Posted Slack message with timestamp: ${messageTs}`);
}

async function handlePRReview(event) {
  const { prNumber, prAuthor, prTitle, repo, reviewState } = event;
  
  if (reviewState !== 'approved') {
    console.log(`Ignoring non-approval review: ${reviewState}`);
    return;
  }
  
  console.log(`Processing approval for PR #${prNumber}`);
  const approvalCount = await github.getReviews(repo, prNumber);
  console.log(`Current approvals: ${approvalCount}`);
  
  const messageTs = await github.findSlackMessageTimestamp(repo, prNumber);
  if (!messageTs) {
    console.log('No Slack message found to update');
    return;
  }
  
  if (approvalCount < CONFIG.REQUIRED_APPROVALS) {
    const message = formatPRMessage(prNumber, prAuthor, prTitle, repo, approvalCount);
    await slack.updateMessage(ENV.slackChannelId, messageTs, message);
    console.log(`Updated Slack message to ${approvalCount}/${CONFIG.REQUIRED_APPROVALS} approvals`);
  } else {
    await slack.deleteMessage(ENV.slackChannelId, messageTs);
    console.log('Deleted Slack message (PR fully approved)');
  }
}

async function handlePRClosed(event) {
  const { prNumber, repo } = event;
  
  console.log(`PR #${prNumber} closed, checking for Slack message`);
  const messageTs = await github.findSlackMessageTimestamp(repo, prNumber);
  
  if (!messageTs) {
    console.log('No Slack message to delete');
    return;
  }
  
  await slack.deleteMessage(ENV.slackChannelId, messageTs);
  console.log('Deleted Slack message');
}

async function main() {
  validateEnvironment();
  const event = loadEventData();
  
  if (!event.prNumber || !event.repo) {
    console.error('Invalid PR data');
    return;
  }
  
  try {
    switch (event.action) {
      case 'opened':
        await handlePROpened(event);
        break;
      case 'submitted':
        await handlePRReview(event);
        break;
      case 'closed':
        await handlePRClosed(event);
        break;
      default:
        console.log(`No action required for event: ${event.action}`);
    }
  } catch (error) {
    console.error(`Error processing ${event.action} event:`, error.message);
    process.exit(1);
  }
}

main();
