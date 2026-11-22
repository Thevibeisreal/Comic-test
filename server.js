
async function collect(url) {
  const host = url.hostname.toLowerCase();
  let html = "";
  let pages = [];

  if (
    host === "mangadex.org" ||
    host.endsWith(".mangadex.org")
  ) {
    pages = await collectMangaDex(url, "");
  } else {
    html = await getHtml(url);

    if (
      host === "comix.to" ||
      host.endsWith(".comix.to")
    ) {
      pages = await collectComix(url, html);
    } else if (
      host === "comicfury.com" ||
      host.endsWith(".comicfury.com") ||
      host.endsWith(".thecomicseries.com")
    ) {
      pages = await collectComicFury(url, html);
    } else {
      const imgs = imageCandidates(html, url.href);
      const $ = cheerio.load(html);
      const title =
        $("h1").first().text().trim() ||
        $("title").text().trim() ||
        "Comic";

      for (const img of imgs.slice(0, 80)) {
        pages.push({
          url: img,
          source: url.href,
          title
        });
      }
    }
  }

  if (!pages.length) {
    throw new Error(
      "No publicly accessible comic pages were found."
    );
  }

  if (pages.length > MAX_TOTAL_PAGES) {
    pages = pages.slice(0, MAX_TOTAL_PAGES);
  }

  const downloaded = [];
  let failures = 0;

  for (let i = 0; i < pages.length; i++) {
    try {
      const image = await imageToFile(
        pages[i].url,
        pages[i].source
      );

      downloaded.push({
        ...image,
        title: pages[i].title,
        number: i + 1
      });
    } catch (e) {
      failures++;
      console.warn("Image skipped:", e.message);
    }
  }

  if (!downloaded.length) {
    throw new Error(
      "Page images were found but the server could not download them."
    );
  }

  if (failures) {
    console.warn(`${failures} pages failed to download.`);
  }

  return {
    title: "ComicVault comic",
    pages: downloaded
  };
}
