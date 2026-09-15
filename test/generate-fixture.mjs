// Generates test/fixture.html: a mock Steam comment thread, the REAL userscript,
// and the REAL test suite inlined into one page you can open in a browser.
//
//   node test/generate-fixture.mjs   # writes test/fixture.html
//
// The mock lives here. The assertions live in test/suite.js, which is a normal
// file so it can be read, syntax-checked and edited like any other source.
import { readFileSync, writeFileSync } from "node:fs";

const userscript = readFileSync(
  new URL("../steam-comment-deleter.user.js", import.meta.url),
  "utf8",
);
const suite = readFileSync(new URL("suite.js", import.meta.url), "utf8");

// A literal closing script tag inside either file would end the injected script
// early. Escaping the slash is a no-op for the JavaScript, and invisible to the
// HTML parser.
const inline = (code) => code.replace(/<\/script>/gi, "<\\/script>");

const mock = `
var PAGES = {
  1: [
    { id: 'alpha', who: 'FriendOne', handle: '76561198000000001', text: 'trade offer sent', when: '12 Jan, 2014 @ 3:24pm' },
    { id: 'bravo', who: 'FriendTwo', handle: '76561198000000002', text: 'gg well played', when: '4 Mar, 2021 @ 9:02am' },
    { id: 'charlie', who: 'FriendThree', handle: '76561198000000003', text: 'thanks for the game', when: null }
  ],
  2: [
    { id: 'delta', who: 'FriendOne', handle: '76561198000000001', text: 'scam link removed', when: '2 Feb, 2013 @ 1:00pm' },
    { id: 'echo', who: 'FriendTwo', handle: '76561198000000002', text: 'nice profile', when: '9 Sep, 2022 @ 6:45pm' },
    { id: 'foxtrot', who: 'FriendThree', handle: '76561198000000003', text: 'happy birthday', when: '30 Dec, 2019 @ 11:11am' }
  ]
};
var current = 1;

function row(comment) {
  return '<div class="commentthread_comment" id="comment_' + comment.id + '">' +
    '<div class="commentthread_comment_author">' +
      '<a href="https://steamcommunity.com/profiles/' + comment.handle + '">' + comment.who + '</a>' +
    '</div>' +
    '<div class="commentthread_comment_text">' + comment.text + '</div>' +
    (comment.when ? '<div class="commentthread_comment_timestamp" title="' + comment.when + '">' + comment.when + '</div>' : '') +
    '<div class="commentthread_comment_actions">' +
      '<a class="actionlink" data-comment-id="' + comment.id + '">Delete</a>' +
    '</div></div>';
}

// Wire the delete links the way Steam does, so a real click really removes one.
function wire() {
  Array.prototype.forEach.call(
    document.querySelectorAll('.commentthread_comment_actions .actionlink'),
    function (link) {
      if (link.dataset.scdFixtureWired) return;
      link.dataset.scdFixtureWired = '1';
      link.addEventListener('click', function () {
        var rowEl = link.closest('.commentthread_comment');
        if (window.__unrelatedDialog) {
          var unrelated = document.createElement('div');
          unrelated.setAttribute('role', 'dialog');
          unrelated.className = 'test-modal';
          unrelated.innerHTML = '<div>Delete this comment?</div><button type="button">Delete</button>';
          unrelated.querySelector('button').addEventListener('click', function () {
            rowEl.remove();
            unrelated.remove();
            if (window.__stopAfterSubmit) setTimeout(window.__stopAfterSubmit, 0);
          });
          document.body.appendChild(unrelated);
        } else if (window.__directDelete) {
          // Deliberately unsafe fixture path: the row vanishes without a
          // supported confirmation, so the userscript must report unknown.
          rowEl.remove();
        } else if (!window.__blockDeletes) {
          var showModal = function () {
            var modal = document.createElement('div');
            modal.setAttribute('role', 'dialog');
            modal.className = 'test-modal';
            modal.setAttribute('data-comment-id', rowEl.id.replace(/^comment_/, ''));
            modal.innerHTML = '<div>Delete this comment?</div><button type="button">Delete</button>';
            modal.querySelector('button').addEventListener('click', function () {
              rowEl.remove();
              if (window.__appendNewAfterDelete) {
                window.__appendNewAfterDelete = false;
                document.querySelector('.commentthread_comments').insertAdjacentHTML(
                  'beforeend',
                  row({ id: 'late', who: 'LateComment', handle: '76561198000000009', text: 'new row after preview', when: '1 Jan, 2024 @ 1:00pm' }),
                );
                wire();
              }
              modal.remove();
              if (window.__stopAfterSubmit) setTimeout(window.__stopAfterSubmit, 0);
            });
            document.body.appendChild(modal);
          };
          if (window.__dialogDeletes) setTimeout(showModal, 180);
          else showModal();
        }
      });
    }
  );
}

function render() {
  Array.prototype.forEach.call(document.querySelectorAll('.test-modal'), function (modal) {
    modal.remove();
  });
  document.getElementById('commentthread_Profile_test').innerHTML =
    '<div class="commentthread_comments">' + PAGES[current].map(row).join('') + '</div>' +
    '<div class="commentthread_pagelinks">' +
      '<a class="pagebtn' + (current === 1 ? ' active' : '') + '" onclick="window.__go(1)">1</a>' +
      '<a class="pagebtn' + (current === 2 ? ' active' : '') + '" onclick="window.__go(2)">2</a>' +
    '</div>';
  wire();
}

window.__go = function (n) {
  if (n === current || !PAGES[n]) return;
  current = n;
  render();
};
window.__renderComments = function () {
  current = window.__current || current;
  render();
};
window.__wire = wire;

document.getElementById('host').innerHTML = '<div id="commentthread_Profile_test"></div>';
render();
`;

// Runs before the userscript. Two jobs: let the suite see what the script
// logged on the way up (including the banner a stuck user is told to look for),
// and wipe the saved preferences first, because the suite's own later tests
// write them to localStorage and a refresh would otherwise inherit them and
// report failures that are really just yesterday's settings.
const prelude = `
window.__SCD_TEST__ = true;
window.__blockDeletes = false;
window.__dialogDeletes = false;
window.__directDelete = false;
window.__appendNewAfterDelete = false;
window.__console = [];
['log', 'info', 'warn', 'error'].forEach(function (level) {
  var original = console[level];
  console[level] = function () {
    window.__console.push({ level: level, text: Array.prototype.slice.call(arguments).join(' ') });
    return original.apply(console, arguments);
  };
});
['localStorage', 'sessionStorage'].forEach(function (name) {
  try {
    var store = window[name];
    Object.keys(store)
      .filter(function (key) { return key.indexOf('scd_') === 0; })
      .forEach(function (key) { store.removeItem(key); });
  } catch (e) {}
});
`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Steam Comment Deleter test</title></head>
<body>
<div id="host"></div>
<pre id="results" style="font:13px monospace;white-space:pre-wrap">running...</pre>
<script>
${mock}</script>
<script>
${prelude}</script>
<script>
${inline(userscript)}</script>
<script>
${inline(suite)}</script>
</body></html>`;

const output = new URL("fixture.html", import.meta.url);
writeFileSync(output, html);
console.log("wrote " + output.pathname + " (" + html.length + " bytes)");
console.log("open it in a browser and read the PASS/FAIL block at the top.");
