const MODULE_ID = "bardic-inspiration-tracker";

// ------------------------------------------------------------
// SETTINGS
// ------------------------------------------------------------

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "partyMethod", {
        name: "Party Detection Method",
        hint: "Determines how party members are detected.",
        scope: "world",
        config: true,
        type: String,
        choices: {
            folder: "Same Folder",
            scene: "Active Scene Tokens"
        },
        default: "folder"
    });
});

// ------------------------------------------------------------
// SOCKETLIB
// ------------------------------------------------------------

Hooks.once("ready", () => {
    if (!game.modules.get("socketlib")?.active) {
        console.warn(`${MODULE_ID} | socketlib is not active.`);
        return;
    }

    const socket = socketlib.registerModule(MODULE_ID);

    socket.register("giveInspiration", async (targetActorId, sourceActorId, sourceActorName, inspirationDie) => {
        const actor = game.actors.get(targetActorId);

        if (!actor) {
            console.warn(`${MODULE_ID} | Target actor not found:`, targetActorId);
            return;
        }

        await actor.setFlag(MODULE_ID, "inspired", true);
        await actor.setFlag(MODULE_ID, "sourceActorId", sourceActorId);
        await actor.setFlag(MODULE_ID, "sourceActorName", sourceActorName);
        await actor.setFlag(MODULE_ID, "inspirationDie", inspirationDie);

        ui.notifications.info(`${actor.name} gained Bardic Inspiration (${inspirationDie}).`);

        renderOpenSheets(actor);
    });

    game.bardicInspirationTracker = {
        socket
    };
});

// ------------------------------------------------------------
// ACTOR HELPERS
// ------------------------------------------------------------

function isInspired(actor) {
    return actor?.getFlag(MODULE_ID, "inspired") === true;
}

function getInspirationDie(actor) {
    return actor?.getFlag(MODULE_ID, "inspirationDie") ?? "1d6";
}

function getSourceActorName(actor) {
    return actor?.getFlag(MODULE_ID, "sourceActorName") ?? "a Bard";
}

async function consumeInspiration(actor) {
    if (!actor || !isInspired(actor)) return;

    await actor.unsetFlag(MODULE_ID, "inspired");
    await actor.unsetFlag(MODULE_ID, "sourceActorId");
    await actor.unsetFlag(MODULE_ID, "sourceActorName");
    await actor.unsetFlag(MODULE_ID, "inspirationDie");

    renderOpenSheets(actor);
}

// ------------------------------------------------------------
// BARDIC INSPIRATION DIE
// ------------------------------------------------------------

function getBardicDie(actor) {
    try {
        const die = actor?.getRollData?.()?.scale?.bard?.inspiration;

        if (die) return die;
    } catch (err) {
        console.warn(`${MODULE_ID} | Could not determine Bardic Inspiration die.`, err);
    }

    console.warn(`${MODULE_ID} | Falling back to 1d6 Bardic Inspiration.`);
    return "1d6";
}

// ------------------------------------------------------------
// FIND BARDIC INSPIRATION FEATURE
// ------------------------------------------------------------

function getBardicInspirationItem(actor) {
    return actor?.items?.find(item =>
        item.name?.toLowerCase() === "bardic inspiration"
    );
}

async function consumeBardicInspirationCharge(actor) {
    const item = getBardicInspirationItem(actor);

    if (!item) {
        ui.notifications.warn(`${actor.name} does not have a Bardic Inspiration feature.`);
        return false;
    }

    const uses = item.system?.uses;

    if (!uses) {
        ui.notifications.warn("Bardic Inspiration does not have a usable charge tracker.");
        return false;
    }

    const max = Number(uses.max ?? 0);
    const spent = Number(uses.spent ?? 0);

    if (max > 0 && spent >= max) {
        ui.notifications.warn(`${actor.name} has no Bardic Inspiration uses remaining.`);
        return false;
    }

    await item.update({
        "system.uses.spent": spent + 1
    });

    return true;
}

// ------------------------------------------------------------
// PARTY DETECTION
// ------------------------------------------------------------

function getPartyMembers(actor) {
    const method = game.settings.get(MODULE_ID, "partyMethod");

    if (method === "scene") {
        const members = [];

        for (const token of canvas.tokens?.placeables ?? []) {
            const tokenActor = token.actor;

            if (!tokenActor) continue;
            if (tokenActor.id === actor.id) continue;
            if (tokenActor.type !== "character") continue;

            if (!members.some(a => a.id === tokenActor.id)) {
                members.push(tokenActor);
            }
        }

        return members;
    }

    const folder = actor.folder;

    if (!folder) return [];

    return game.actors.filter(otherActor =>
        otherActor.id !== actor.id &&
        otherActor.folder?.id === folder.id &&
        otherActor.type === "character"
    );
}

// ------------------------------------------------------------
// RENDER SHEET
// ------------------------------------------------------------

Hooks.on("renderActorSheetV2", (app, html) => {
    const actor = app.actor;

    if (!actor) return;

    buildTracker(app, html, actor);
    buildPartyPanel(app, html, actor);
});

// ------------------------------------------------------------
// TRACKER
// ------------------------------------------------------------

function buildTracker(app, html, actor) {
    const root = html instanceof HTMLElement
        ? html
        : html?.[0];

    if (!root) return;

    root.querySelector(".bardic-inspiration-tracker")?.remove();

    if (!isInspired(actor)) return;

    const tracker = document.createElement("div");
    tracker.classList.add("bardic-inspiration-tracker");

    tracker.innerHTML = `
        <button
            type="button"
            class="bardic-inspiration"
            title="Bardic Inspiration available"
        >
            <i class="fas fa-music"></i>
            <span>Bardic Inspiration</span>
        </button>
    `;

    tracker.querySelector(".bardic-inspiration")?.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();

        ui.notifications.info(
            "Bardic Inspiration will be offered automatically when you make an eligible roll."
        );
    });

    const header = root.querySelector("header");
    const tabs = root.querySelector(".sheet-tabs");

    if (header) {
        header.appendChild(tracker);
    } else if (tabs) {
        tabs.parentElement?.insertBefore(tracker, tabs);
    } else {
        root.prepend(tracker);
    }
}

// ------------------------------------------------------------
// PARTY PANEL
// ------------------------------------------------------------

function buildPartyPanel(app, html, actor) {
    if (actor.type !== "character") return;

    const isBard = actor.items?.some(item =>
        item.name?.toLowerCase() === "bard"
    ) || actor.system?.details?.class?.toLowerCase?.() === "bard";

    if (!isBard) return;

    const root = html instanceof HTMLElement
        ? html
        : html?.[0];

    if (!root) return;

    root.querySelector(".bardic-inspiration-party")?.remove();

    const members = getPartyMembers(actor);

    if (!members.length) return;

    const panel = document.createElement("div");
    panel.classList.add("bardic-inspiration-party");

    panel.innerHTML = `
        <div class="bardic-inspiration-party-title">
            <i class="fas fa-music"></i>
            Bardic Inspiration
        </div>
        <div class="bardic-inspiration-party-list"></div>
    `;

    const list = panel.querySelector(".bardic-inspiration-party-list");

    for (const member of members) {
        const inspired = isInspired(member);

        const button = document.createElement("button");
        button.type = "button";
        button.classList.add("bardic-party-member");

        if (inspired) {
            button.disabled = true;
            button.classList.add("inspired");
        }

        button.innerHTML = `
            <img src="${member.img}" />
            <span>${member.name}</span>
            ${inspired ? `<i class="fas fa-check"></i>` : ""}
        `;

        if (!inspired) {
            button.addEventListener("click", async event => {
                event.preventDefault();
                event.stopPropagation();

                await grantBardicInspiration(actor, member);
            });
        }

        list.appendChild(button);
    }

    const detailsTab =
        root.querySelector('[data-tab="details"]') ||
        root.querySelector(".tab.details");

    if (detailsTab) {
        detailsTab.appendChild(panel);
    } else {
        root.appendChild(panel);
    }
}

// ------------------------------------------------------------
// GRANT BARDIC INSPIRATION
// ------------------------------------------------------------

async function grantBardicInspiration(sourceActor, targetActor) {
    if (!sourceActor || !targetActor) return;

    if (isInspired(targetActor)) {
        ui.notifications.warn(`${targetActor.name} already has Bardic Inspiration.`);
        return;
    }

    if (!game.user.isGM && !game.users.find(u => u.isGM && u.active)) {
        ui.notifications.error("No active GM is available.");
        return;
    }

    const inspirationDie = getBardicDie(sourceActor);

    const consumed = await consumeBardicInspirationCharge(sourceActor);

    if (!consumed) return;

    const socket = game.bardicInspirationTracker?.socket;

    if (!socket) {
        ui.notifications.error("Bardic Inspiration socket is not available.");
        return;
    }

    try {
        await socket.executeAsGM(
            "giveInspiration",
            targetActor.id,
            sourceActor.id,
            sourceActor.name,
            inspirationDie
        );

        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: sourceActor }),
            content: `
                <p><strong>${sourceActor.name}</strong> inspires
                <strong>${targetActor.name}</strong> with Bardic Inspiration!</p>
                <p>Inspiration die: <strong>${inspirationDie}</strong></p>
            `
        });

        renderOpenSheets(sourceActor);
        renderOpenSheets(targetActor);

    } catch (err) {
        console.error(`${MODULE_ID} | Failed to grant Bardic Inspiration:`, err);

        ui.notifications.error(
            "Something went wrong while granting Bardic Inspiration."
        );
    }
}

// ------------------------------------------------------------
// BARDIC INSPIRATION PROMPT
// ------------------------------------------------------------

async function promptForBardicInspiration(actor, config) {
    const die = getInspirationDie(actor);
    const sourceName = getSourceActorName(actor);

    const message =
        `${sourceName} gave you Bardic Inspiration (${die}). ` +
        `Would you like to add it to this roll?`;

    // Foundry V13 DialogV2
    if (foundry?.applications?.api?.DialogV2) {
        return await foundry.applications.api.DialogV2.confirm({
            window: {
                title: "Bardic Inspiration"
            },
            content: `
                <p>${message}</p>
                <p><strong>Inspiration Die: ${die}</strong></p>
            `,
            yes: {
                label: "Yes"
            },
            no: {
                label: "No"
            }
        });
    }

    // Legacy fallback
    return await new Promise(resolve => {
        new Dialog({
            title: "Bardic Inspiration",
            content: `
                <p>${message}</p>
                <p><strong>Inspiration Die: ${die}</strong></p>
            `,
            buttons: {
                yes: {
                    label: "Yes",
                    callback: () => resolve(true)
                },
                no: {
                    label: "No",
                    callback: () => resolve(false)
                }
            },
            default: "no",
            close: () => resolve(false)
        }).render(true);
    });
}

// ------------------------------------------------------------
// PRE-ROLL HANDLER
// ------------------------------------------------------------

async function handleBardicPreRoll(config, dialog, message) {
    if (!config) return;

    // Prevent our manually-created roll from triggering the prompt again.
    if (config._bardicInspirationHandled) return;

    // D&D 5e 5.3.3 does not place the actor on config.
    // The current user's character is the actor making the roll.
    const actor = config.actor ?? game.user.character;

    if (!actor) return;

    if (!isInspired(actor)) return;

    const inspirationDie = getInspirationDie(actor);

    console.log(
        `${MODULE_ID} | Bardic Inspiration available for ${actor.name}`,
        {
            config,
            inspirationDie
        }
    );

    // Cancel the normal roll while we ask the player.
    const choicePromise = promptForBardicInspiration(actor, config);

    // The hook itself cannot await our prompt, so cancel the original
    // roll immediately and perform it manually after the choice.
    choicePromise.then(async useInspiration => {

        const rerollConfig = foundry.utils.deepClone(config);

        rerollConfig._bardicInspirationHandled = true;

        // Do not open the normal Advantage/Normal/Disadvantage dialog again.
        rerollConfig.configure = false;

        // If the player says NO, reproduce the original roll.
        if (!useInspiration) {
            try {
                await CONFIG.Dice.D20Roll.build(
                    rerollConfig,
                    {
                        configure: false
                    },
                    message
                );
            } catch (err) {
                console.error(
                    `${MODULE_ID} | Failed to perform normal roll after declining Inspiration:`,
                    err
                );
            }

            return;
        }

        // Player said YES.
        //
        // Add the Inspiration die to every roll configuration contained
        // in the D&D 5e roll config.
        if (Array.isArray(rerollConfig.rolls)) {
            for (const rollConfig of rerollConfig.rolls) {
                if (!Array.isArray(rollConfig.parts)) {
                    rollConfig.parts = [];
                }

                rollConfig.parts.push(inspirationDie);
            }
        } else {
            // Fallback if the roll config does not contain a rolls array.
            if (!Array.isArray(rerollConfig.parts)) {
                rerollConfig.parts = [];
            }

            rerollConfig.parts.push(inspirationDie);
        }

        try {
            await CONFIG.Dice.D20Roll.build(
                rerollConfig,
                {
                    configure: false
                },
                message
            );

            // Inspiration is consumed only after the enhanced roll
            // has successfully been created.
            await consumeInspiration(actor);

            ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `
                    <p><strong>${actor.name}</strong> used Bardic Inspiration!</p>
                    <p>Added <strong>${inspirationDie}</strong> to the roll.</p>
                `
            });

        } catch (err) {
            console.error(
                `${MODULE_ID} | Failed to perform Bardic Inspiration roll:`,
                err
            );

            ui.notifications.error(
                "The Bardic Inspiration roll could not be completed. Your Inspiration was not consumed."
            );
        }
    });

    // IMPORTANT:
    // The original D&D 5e roll must be stopped while our asynchronous
    // prompt is displayed.
    return false;
}

// ------------------------------------------------------------
// SKILL CHECKS
// ------------------------------------------------------------

Hooks.on("dnd5e.preRollSkill", (config, dialog, message) => {
    return handleBardicPreRoll(config, dialog, message);
});

// ------------------------------------------------------------
// ABILITY CHECKS
// ------------------------------------------------------------

Hooks.on("dnd5e.preRollAbilityCheck", (config, dialog, message) => {
    return handleBardicPreRoll(config, dialog, message);
});

// Some versions use AbilityTest terminology.
// This is harmless if the hook is not fired.
Hooks.on("dnd5e.preRollAbilityTest", (config, dialog, message) => {
    return handleBardicPreRoll(config, dialog, message);
});

// ------------------------------------------------------------
// SAVING THROWS
// ------------------------------------------------------------

Hooks.on("dnd5e.preRollSavingThrow", (config, dialog, message) => {
    return handleBardicPreRoll(config, dialog, message);
});

// ------------------------------------------------------------
// ATTACKS
// ------------------------------------------------------------
//
// D&D 5e V2 attack workflow.

Hooks.on("dnd5e.preRollAttackV2", (config, dialog, message) => {
    return handleBardicPreRoll(config, dialog, message);
});

// ------------------------------------------------------------
// REFRESH SHEETS
// ------------------------------------------------------------

function renderOpenSheets(actor) {
    if (!actor) return;

    for (const app of actor.apps ? Object.values(actor.apps) : []) {
        try {
            app.render();
        } catch (err) {
            console.warn(`${MODULE_ID} | Could not render sheet.`, err);
        }
    }

    // Foundry V13 application collection fallback
    for (const app of Object.values(ui.windows ?? {})) {
        if (app?.actor?.id === actor.id) {
            try {
                app.render();
            } catch (err) {
                console.warn(`${MODULE_ID} | Could not render application.`, err);
            }
        }
    }
}

// ------------------------------------------------------------
// ACTOR LIFECYCLE
// ------------------------------------------------------------

Hooks.on("createActor", actor => {
    renderOpenSheets(actor);
});

Hooks.on("updateActor", actor => {
    renderOpenSheets(actor);
});

Hooks.on("deleteActor", actor => {
    renderOpenSheets(actor);
});

// ------------------------------------------------------------
// RESTS
// ------------------------------------------------------------

Hooks.on("dnd5e.shortRest", async actor => {
    await consumeInspiration(actor);
});

Hooks.on("dnd5e.longRest", async actor => {
    await consumeInspiration(actor);
});

// ------------------------------------------------------------
// DEBUG
// ------------------------------------------------------------

console.log(`${MODULE_ID} | Loaded.`);
