const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBookmarkArticle, mergeBookmarks } = require('./bookmark-utils');

test('normalizeBookmarkArticle returns a stable bookmark payload', () => {
  const article = {
    id: 'abc123',
    title: 'Power outage update',
    summary: 'Heavy rain affected the grid.',
    timeAgo: '2h ago',
    image: 'https://example.com/image.jpg',
    source: 'ECG',
    url: 'https://example.com/story',
    category: 'outage',
    publishedAt: '2025-01-01T00:00:00.000Z',
  };

  assert.deepEqual(normalizeBookmarkArticle(article), {
    id: 'abc123',
    title: 'Power outage update',
    summary: 'Heavy rain affected the grid.',
    timeAgo: '2h ago',
    image: 'https://example.com/image.jpg',
    source: 'ECG',
    url: 'https://example.com/story',
    category: 'outage',
    publishedAt: '2025-01-01T00:00:00.000Z',
  });
});

test('mergeBookmarks adds and removes by article id without duplicates', () => {
  const existing = [
    { id: 'a', title: 'First' },
    { id: 'b', title: 'Second' },
  ];

  assert.deepEqual(mergeBookmarks(existing, { id: 'c', title: 'Third' }, 'add'), [
    { id: 'c', title: 'Third' },
    { id: 'a', title: 'First' },
    { id: 'b', title: 'Second' },
  ]);

  assert.deepEqual(mergeBookmarks(existing, { id: 'a', title: 'First' }, 'remove'), [
    { id: 'b', title: 'Second' },
  ]);
});
