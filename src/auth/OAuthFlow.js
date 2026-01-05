const http = require("http");
const { exec } = require("child_process");
const readline = require("readline");

const httpClient = require("./httpClient");

function getRandom5Port(min = 50000, max = 59999) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class OAuthFlow {
  constructor(options = {}) {
    this.authManager = options.authManager || null;
    this.logger = options.logger || null;
    this.rateLimiter = options.rateLimiter || null;
    this._notifyOAuthDone = null;
  }

  log(title, data) {
    if (this.logger) {
      if (typeof this.logger === "function") {
        return this.logger(title, data);
      }
      if (typeof this.logger.log === "function") {
        return this.logger.log(title, data);
      }
    }
    if (data !== undefined && data !== null) {
      console.log(`[${title}]`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    } else {
      console.log(`[${title}]`);
    }
  }

  getAuthUrl(callbackPort) {
    const { clientId } = httpClient.getOAuthClient();
    return `https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs&state=0b843d51-1c3a-469f-ad85-042f717ab161&prompt=consent&response_type=code&client_id=${encodeURIComponent(
      clientId
    )}&redirect_uri=http%3A%2F%2Flocalhost%3A${callbackPort}%2Foauth-callback`;
  }

  async exchangeCode(code, port) {
    return httpClient.exchangeCodeForToken(code, port, this.rateLimiter);
  }

  startCallbackServer(startPort = 50000, maxPort = 59999, useRandomPort = false) {
    return new Promise((resolve, reject) => {
      let attempts = 0;

      const attemptServer = (port) => {
        attempts++;

        const server = http.createServer(async (req, res) => {
          try {
            const url = new URL(req.url, `http://localhost:${port}`);

            if (req.method === "GET" && url.pathname === "/oauth-callback") {
              const code = url.searchParams.get("code");
              const error = url.searchParams.get("error");

              if (error) {
                const errorDesc = url.searchParams.get("error_description") || error;
                const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login Failed</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #f5f5f5; color: #333; }
        .container { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); text-align: center; max-width: 400px; width: 90%; }
        .icon { font-size: 48px; margin-bottom: 1rem; color: #ef4444; }
        h1 { margin: 0 0 1rem; font-size: 24px; }
        p { margin: 0; color: #666; line-height: 1.5; }
        .error-details { margin-top: 1rem; padding: 0.75rem; background-color: #fef2f2; border: 1px solid #fee2e2; border-radius: 6px; color: #b91c1c; font-size: 0.875rem; word-break: break-all; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">❌</div>
        <h1>Login Failed</h1>
        <p>We encountered an error while trying to log you in.</p>
        <div class="error-details">${errorDesc}</div>
    </div>
</body>
</html>`;
                res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
                res.end(html);
                return;
              }

              if (code) {
                try {
                  const creds = await this.exchangeCode(code, port);
                  if (this.authManager) {
                    await this.authManager.addAccount(creds);
                  }
                  if (typeof this._notifyOAuthDone === "function") {
                    try {
                      this._notifyOAuthDone();
                    } catch (e) {}
                  }

                  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login Successful</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #f5f5f5; color: #333; }
        .container { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); text-align: center; max-width: 400px; width: 90%; }
        .icon { font-size: 48px; margin-bottom: 1rem; color: #22c55e; }
        h1 { margin: 0 0 1rem; font-size: 24px; }
        p { margin: 0; color: #666; line-height: 1.5; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✅</div>
        <h1>Login Successful</h1>
        <p>You have successfully logged in. You can close this window now and return to the terminal.</p>
    </div>
    <script>
        setTimeout(() => { window.close(); }, 3000);
    </script>
</body>
</html>`;
                  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                  res.end(html);
                  return;
                } catch (tokenError) {
                  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Error</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #f5f5f5; color: #333; }
        .container { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); text-align: center; max-width: 400px; width: 90%; }
        .icon { font-size: 48px; margin-bottom: 1rem; color: #ef4444; }
        h1 { margin: 0 0 1rem; font-size: 24px; }
        p { margin: 0; color: #666; line-height: 1.5; }
        .error-details { margin-top: 1rem; padding: 0.75rem; background-color: #fef2f2; border: 1px solid #fee2e2; border-radius: 6px; color: #b91c1c; font-size: 0.875rem; word-break: break-all; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">❌</div>
        <h1>Authentication Error</h1>
        <p>Failed to retrieve access token.</p>
        <div class="error-details">${tokenError.message}</div>
    </div>
</body>
</html>`;
                  res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
                  res.end(html);
                  return;
                }
              }

              const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OAuth Callback</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #f5f5f5; color: #333; }
        .container { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); text-align: center; max-width: 400px; width: 90%; }
        h1 { margin: 0 0 1rem; font-size: 24px; }
        p { margin: 0; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>OAuth Callback Endpoint</h1>
        <p>This endpoint is ready to receive OAuth callbacks.</p>
    </div>
</body>
</html>`;
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(html);
              return;
            }

            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Page not found");
          } catch (error) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal Server Error\n");
          }
        });

        server.listen(port, (err) => {
          if (err) {
            if (useRandomPort) {
              attemptServer(getRandom5Port());
            } else if (port < maxPort) {
              attemptServer(port + 1);
            } else {
              reject(new Error(`Could not find available port in range: ${startPort}-${maxPort}`));
            }
          } else {
            const oauthCallbackUrl = `http://localhost:${port}/oauth-callback`;
            resolve({
              server,
              port,
              url: `http://localhost:${port}`,
              oauthCallbackUrl,
              attempts,
            });
          }
        });

        server.on("error", (error) => {
          if (error.code === "EADDRINUSE") {
            if (useRandomPort) {
              attemptServer(getRandom5Port());
            } else if (port < maxPort) {
              attemptServer(port + 1);
            } else {
              reject(new Error(`Could not find available port in range: ${startPort}-${maxPort}`));
            }
          } else {
            reject(error);
          }
        });
      };

      if (useRandomPort) {
        attemptServer(getRandom5Port());
      } else {
        attemptServer(startPort);
      }
    });
  }

  startInteractiveFlow() {
    if (!this.authManager) {
      throw new Error("OAuthFlow requires authManager to save credentials");
    }

    return new Promise((resolve) => {
      this.startCallbackServer()
        .then((serverInfo) => {
          const { port, server } = serverInfo;
          let completed = false;
          let rl;

          const finish = (success) => {
            if (completed) return;
            completed = true;
            if (rl) {
              try {
                rl.close();
              } catch (e) {}
            }
            if (server) {
              try {
                server.close();
              } catch (e) {}
            }
            if (process.stdin.isTTY) {
              try {
                process.stdin.pause();
              } catch (e) {}
            }
            resolve(!!success);
          };

          this._notifyOAuthDone = () => finish(true);

          const handleCode = async (code) => {
            if (completed) return;
            try {
              const creds = await this.exchangeCode(code, port);
              await this.authManager.addAccount(creds);
              this.log("info", "✅ Authorization successful.");
              finish(true);
            } catch (err) {
              this.log("error", `Failed to exchange code: ${err.message || err}`);
            }
          };

          const authUrl = this.getAuthUrl(port);
          this.log("info", `👉 Please open the following URL in your browser to authorize:\n${authUrl}\n`);

          if (process.platform === "win32") {
            exec(`start "" "${authUrl}"`);
          } else {
            const openCommand = process.platform === "darwin" ? "open" : "xdg-open";
            exec(`${openCommand} "${authUrl}"`);
          }

          rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          this.log("info", "ℹ️ 如在其他设备授权，请粘贴完整的回调链接并回车；或直接等待浏览器自动回调。");
          rl.on("line", (line) => {
            if (completed) return;
            const trimmed = (line || "").trim();
            if (!trimmed) {
              this.log("info", "继续等待浏览器回调或粘贴链接...");
              return;
            }
            try {
              const url = new URL(trimmed);
              const code = url.searchParams.get("code");
              if (!code) {
                this.log("warn", "未找到 code 参数，请粘贴完整的回调 URL。");
                return;
              }
              handleCode(code);
            } catch (e) {
              this.log("warn", "无效的 URL，请粘贴完整的回调 URL。");
            }
          });
        })
        .catch((err) => {
          this.log("error", `Failed to start OAuth callback server: ${err.message || err}`);
          resolve(false);
        });
    });
  }
}

module.exports = OAuthFlow;
