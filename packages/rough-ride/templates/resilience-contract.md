<!-- resilience-contract edition=1 -->
## Resilience contract

Code you change here is tested in a real browser with requests that fail, are refused or rate-limited, lose the connection, never answer, answer late or return empty or unreadable data, plus expired sessions, double clicks, reloads, the back button, answers that arrive out of order, odd input and a 375 px wide screen. Design for these from the start:

1. When a request fails and retries do not fix it, say so on the page, not only in the console. Never show a failed or unreadable response as an empty list, a default or a success.
2. Requests your code sends time out after 10 seconds and fail like any other error; longer work, such as an upload, shows progress and can be cancelled. Nothing spins forever or stays disabled.
3. After a failure, trying again on the same page works once the server is back, without a reload. Never cache a failed result.
4. A failed or refused submit keeps everything the user typed.
5. Saving, sending or deleting twice, by a double click or a retry after a timeout, makes one change.
6. Every field accepts a value and shows it correctly, or refuses it with a visible reason, whatever is typed: blank, very long, emoji, other scripts, quotes, markup, extreme numbers or dates. The server validates every input and answers bad input with a 4xx, never a 5xx.
7. Treat responses as untrusted: error bodies may not be JSON, lists may be empty, fields may be null. No error goes uncaught, and the page never shows undefined, NaN, [object Object], Invalid Date or a stack trace.
8. A page that loads data has loading, empty and error states; its error state offers a retry and is the same whether the page was opened directly or through a link in the app.
9. When the session expires, take the user to sign in or say so; never loop or blank the page.
10. Pages fit 375 px wide without sideways scrolling, long user text included.
11. An answer that arrives late never replaces newer results on the page.

This is for real users on bad networks: the app behaves the same for every visitor.
<!-- /resilience-contract -->
