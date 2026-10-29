async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          beginJob("uninstall", "locate");
          try {
            const result = await uninstaller.uninstallPurge({
              onStage(stage) {
                setApplyProgress({ kind: "uninstall", stage });
              },
            });
            endApply({
              kind: "uninstall",
              stage: "done",
              error: result.ok ? "" : (result.errors && result.errors[0]) || "incomplete",
            });
            sendJson(response, result.ok ? 200 : 500, {
              ...result,
              surface: hostctl.currentSurface(),
              fullApp: hostctl.currentSurface() === "desktop",
              note: result.ok ? hostctl.restartNote() : undefined,
            });
            if (result.ok) {
              uninstaller.scheduleCleanupRestart({
                request,
                cleanup: result.cleanup,
                ctx,
              });
            }
          } catch (e) {
            endApply({ kind: "uninstall", error: String(e && e.message ? e.message : e) });
            sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
          }
        }
