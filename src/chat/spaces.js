'use strict';

// Creates deal spaces in Google Chat as the Basecamp app and adds people to them. Uses app
// authentication with two scopes a Workspace admin must approve once: creating spaces and
// managing memberships. Chat apps cannot pin messages (pins need a person's sign-in), so a
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

function createSpaces({ auth = defaultAuth(), readAuth = botAuth() } = {}) {
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

  return { createSpace, addMember, findSpace, listSpaces, isMember };
}

module.exports = { createSpaces, NAME_MAX, DESCRIPTION_MAX };
