function normalizeBookmarkArticle(article) {
  if (!article || typeof article !== 'object') return null;

  const id = String(article.id || article._id || '').trim();
  const title = String(article.title || '').trim();
  if (!id || !title) return null;

  const normalized = { id, title };

  const summary = String(article.summary || article.description || '').trim();
  if (summary) normalized.summary = summary;

  const timeAgo = String(article.timeAgo || '').trim();
  if (timeAgo) normalized.timeAgo = timeAgo;

  if (article.image) normalized.image = article.image;
  if (article.source || article.sourceName) normalized.source = article.source || article.sourceName;
  if (article.url) normalized.url = article.url;
  if (article.category) normalized.category = article.category;
  if (article.publishedAt) normalized.publishedAt = article.publishedAt;

  return normalized;
}

function mergeBookmarks(existing, article, action) {
  const current = Array.isArray(existing) ? existing : [];
  const normalizedArticle = normalizeBookmarkArticle(article);

  if (!normalizedArticle) return current;

  const filtered = current.filter((item) => item && item.id !== normalizedArticle.id);
  if (action === 'remove') return filtered;

  return [normalizedArticle, ...filtered];
}

module.exports = { normalizeBookmarkArticle, mergeBookmarks };
