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

  return { createSpace, addMember, findSpace };
}

module.exports = { createSpaces, NAME_MAX, DESCRIPTION_MAX };
