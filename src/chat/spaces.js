'use strict';

// Creates deal spaces in Google Chat as the Basecamp app and adds people to them. Uses app
// authentication with two scopes a Workspace admin must approve once: creating spaces and
// managing memberships; reading a space's messages (for commitment follow-ups) uses a
// third, chat.app.messages.readonly. Chat apps cannot pin messages (pins need a person's sign-in), so a
// deal space's brief is its first post, for a person to pin.

const { safeError } = require('../errors');
const { GoogleAuth } = require('google-auth-library');

const API = 'https://chat.googleapis.com/v1';
const SCOPES = ['https://www.googleapis.com/auth/chat.app.spaces.create', 'https://www.googleapis.com/auth/chat.app.memberships'];

// Chat's limits on a space's name and description.
const NAME_MAX = 128;
const DESCRIPTION_MAX = 150;
const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const defaultAuth = () => new GoogleAuth({ scopes: SCOPES });
const botAuth = () => new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/chat.bot'] });

const readMessagesAuth = () => new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/chat.app.messages.readonly'] });

function createSpaces({ auth = defaultAuth(), readAuth = botAuth(), messagesAuth = readMessagesAuth() } = {}) {
  // A new named space with Basecamp in it. Returns { name: "spaces/...", uri }.
  async function createSpace({ displayName, description }) {
    const client = await auth.getClient();
    const res = await client.request({
      url: `${API}/spaces`,
      method: 'POST',
      data: {
        spaceType: 'SPACE',
        // Required when an app creates a space; this alias means ROA's own Workspace.
        customer: 'customers/my_customer',
        displayName: fit(displayName, NAME_MAX),
        spaceDetails: { description: fit(description, DESCRIPTION_MAX) },
      },
    });
    if (!/^spaces\/[\w-]+$/.test(res.data.name || '')) throw safeError('createSpace: Chat returned no space name');
    return { name: res.data.name, uri: res.data.spaceUri || null };
  }

  // Adds one person, by their Chat user resource name ("users/123").
  async function addMember(spaceName, userName) {
    if (!/^spaces\/[\w-]+$/.test(spaceName || '')) throw safeError('addMember: invalid space name');
    if (!/^users\/[\w-]+$/.test(userName || '')) throw safeError('addMember: invalid user name');
    const client = await auth.getClient();
    await client.request({ url: `${API}/${spaceName}/members`, method: 'POST', data: { member: { name: userName, type: 'HUMAN' } } });
  }

  // The space's link, or null when it no longer exists or Basecamp is no longer in it, so a
  // deleted space can be opened again.
  async function findSpace(spaceName) {
    if (!/^spaces\/[\w-]+$/.test(spaceName || '')) return null;
    const client = await readAuth.getClient();
    try {
      const res = await client.request({ url: `${API}/${spaceName}`, method: 'GET' });
      return { name: spaceName, uri: res.data.spaceUri || null };
    } catch (err) {
      const status = err.status || (err.response && err.response.status);
      if (status === 404 || status === 403) return null;
      throw err;
    }
  }

  // Every named space Basecamp is in, as { name, displayName, uri }. Deal spaces are among
  // them; callers check each against the deal's brief note before trusting it.
  async function listSpaces() {
    const client = await readAuth.getClient();
    const out = [];
    let pageToken;
    do {
      const query = `pageSize=1000&filter=${encodeURIComponent('spaceType = "SPACE"')}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await client.request({ url: `${API}/spaces?${query}`, method: 'GET' });
      for (const sp of res.data.spaces || []) out.push({ name: sp.name, displayName: sp.displayName || '', uri: sp.spaceUri || null });
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return out;
  }

  // Whether one person ("users/123") is in a space Basecamp is in.
  async function isMember(spaceName, userName) {
    if (!/^spaces\/[\w-]+$/.test(spaceName || '') || !/^users\/[\w-]+$/.test(userName || '')) return false;
    const client = await readAuth.getClient();
    try {
      // A membership is named "spaces/X/members/123", after the person's user id.
      await client.request({ url: `${API}/${spaceName}/members/${userName.slice('users/'.length)}`, method: 'GET' });
      return true;
    } catch (err) {
      const status = err.status || (err.response && err.response.status);
      if (status === 404) return false;
      throw err;
    }
  }

  // What people said in a space since `since` (a Date), oldest first, as [{ who, at, text }].
  // Basecamp's own messages and other apps' are left out. Needs the messages scope a
  // Workspace admin approves (chat.app.messages.readonly). At most `max` messages, the
  // newest ones. With app authentication Chat may leave a sender's name off; `who` is then null.
  async function listMessages(spaceName, since, { max = 200 } = {}) {
    if (!/^spaces\/[\w-]+$/.test(spaceName || '')) throw safeError('listMessages: invalid space name');
    if (!(since instanceof Date) || Number.isNaN(since.getTime())) throw safeError('listMessages: invalid time');
    const client = await messagesAuth.getClient();
    const out = [];
    let pageToken;
    do {
      const query = `pageSize=100&orderBy=${encodeURIComponent('createTime desc')}&filter=${encodeURIComponent(`createTime > "${since.toISOString()}"`)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await client.request({ url: `${API}/${spaceName}/messages?${query}`, method: 'GET' });
      for (const m of res.data.messages || []) {
        const sender = m.sender || {};
        const text = String(m.text || m.argumentText || '').trim();
        if (sender.type === 'BOT' || !text) continue;
        out.push({ who: sender.displayName || null, at: m.createTime, text });
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken && out.length < max);
    return out.slice(0, max).reverse();
  }

  return { createSpace, addMember, findSpace, listSpaces, isMember, listMessages };
}

module.exports = { createSpaces, NAME_MAX, DESCRIPTION_MAX };
