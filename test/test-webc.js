const test = require("ava");
const Eleventy = require("@11ty/eleventy");

test("Using <eleventy-image>", async t => {
  let elev = new Eleventy( "test/webc/simple.webc", "test/webc/_site", {
    configPath: "test/webc/eleventy.config.js"
  });

  let results = await elev.toJSON();
  t.is(results[0].content, `<img loading="lazy" src="/img/KkPMmHd3hP-1280.jpeg" alt="My ugly mug" width="1280" height="853">`);
});

test("With formats", async t => {
  let elev = new Eleventy( "test/webc/formats.webc", "test/webc/_site", {
    configPath: "test/webc/eleventy.config.js"
  });

  let results = await elev.toJSON();
  t.is(results[0].content, `<picture><source type="image/webp" srcset="/img/KkPMmHd3hP-1280.webp 1280w"><img loading="lazy" src="/img/KkPMmHd3hP-1280.png" alt="My ugly mug" width="1280" height="853"></picture>`);
});

test("With widths", async t => {
  let elev = new Eleventy( "test/webc/widths.webc", "test/webc/_site", {
    configPath: "test/webc/eleventy.config.js"
  });

  let results = await elev.toJSON();
  t.is(results[0].content, `<img loading="lazy" src="/img/KkPMmHd3hP-100.jpeg" alt="My ugly mug" width="1280" height="853" srcset="/img/KkPMmHd3hP-100.jpeg 100w, /img/KkPMmHd3hP-200.jpeg 200w, /img/KkPMmHd3hP-1280.jpeg 1280w" sizes="100vw">`);
});

test("With url-path", async t => {
  let elev = new Eleventy( "test/webc/url-path.webc", "test/webc/_site", {
    configPath: "test/webc/eleventy.config.js"
  });

  let results = await elev.toJSON();
  t.is(results[0].content, `<img loading="lazy" src="/some-dir/KkPMmHd3hP-1280.jpeg" alt="photo of my tabby cat" width="1280" height="853">`);
});

