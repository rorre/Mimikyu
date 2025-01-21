<div align="center">
  <img src="https://static1.e926.net/data/81/31/8131c12dafa8c460bb748e35573a26fe.png" />
  <h1 align="center">Mimikyu</h1>
  <p align="center">A mock server of a certain website during certain event</p>
</div>

## Setting Up

You need bun.

## Mock Server

Features:

- Slow response time (random; up to 5s)
- Random deauthentication (aka request rejected and comes back to auth page)
- High chance of request failure (80%) with the amazing "sorry" message
  - There is a 50% chance for the response to be of 200 status code, just like how it works for whatever reason.
- Fake authentication
- HTML responses are 1:1 (except `siakOverload*.html`)
- To disable all fake errors, put an empty file named `.noerr`

To run the server, simply run `bun run main.ts`.
