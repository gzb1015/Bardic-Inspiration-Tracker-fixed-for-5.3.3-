const MODULE_ID = "bardic-inspiration-tracker";
let socket;

// ============================================================
// HOOKS
// ============================================================

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "partyMethod", {
        name: "Party Detection Method",
        hint: "How to determine which characters belong to the same party.",
        scope: "world",
        config: true,
        type: String,
        choices: {
            folder: "Same Folder",
            scene: "Active Scene Tokens",
        },
        default: "folder",
    });
    console.log(`${MODULE_ID} | Initialized`);
});

Hooks.once("socketlib.ready", () => {
    console.log(`${MODULE_ID} | Registering socket listener`);
    socket = socketlib.registerModule(MODULE_ID);
    socket.register("giveInspiration", handleGiveInspiration);
    console.log(`${MODULE_ID} | Socket registered via socketlib`);
});

Hooks.on("renderActorSheetV2", (app, html) => {
    const actor = app.actor ?? app.document;
    if (!actor || actor.type !== "character") return;

    const root = html instanceof jQuery ? html[0] : html;
    if (!root) return;

    const sheetBody = root.querySelector(".window-content") ?? root;

    // TRACK BAR
    const trackBar = buildTrackBar(actor);
    const sheetHeader = sheetBody.querySelector(".sheet-header") ?? sheetBody;
    const sheetLeftDiv = sheetHeader.querySelector(".left") ?? sheetHeader;
    sheetLeftDiv.prepend(trackBar);

    // PARTY PANEL — bards only
    const isBard = actor.items.some(i => i.type === "class" && i.name.toLowerCase() === "bard");
    if (isBard) {
        const partyPanel = buildPartyPanel(actor);
        const rightDetailsTab =
            sheetBody.querySelector('section.tab[data-tab="details"][data-group="primary"] > .right')
            ?? sheetBody;
        rightDetailsTab.append(partyPanel);
    }
});

Hooks.on("createActor", (actor) => {
    if (actor.type !== "character") return;
    refreshOpenPartySheets(actor);
});

Hooks.on("updateActor", (actor, changed) => {
    if (actor.type !== "character") return;
    // If the actor moved folders, every open party sheet could be affected
    if (Object.hasOwn(changed, "folder")) {
        refreshAllOpenCharacterSheets();
        return;
    }
    refreshOpenPartySheets(actor);
});

Hooks.on("deleteActor", (actor) => {
    if (actor.type !== "character") return;
    refreshOpenPartySheets(actor);
});

Hooks.on("dnd5e.shortRest", (actor, data) => {
    consumeInspiration(actor);
});

Hooks.on("dnd5e.longRest", (actor, data) => {
    consumeInspiration(actor);
});

// ============================================================
// UI — TRACK BAR
// ============================================================

function buildTrackBar(sheetActor) {
    const inspired = isInspired(sheetActor);
    const trackBar = document.createElement("div");
    trackBar.classList.add("track-bar");
    trackBar.innerHTML = `
        <button
            type="button"
            class="bardic-inspiration${inspired ? "" : " hidden"}"
            data-tooltip="Inspired! Click to roll.">
            <i class="fas fa-music"></i>
        </button>
    `;

    trackBar.querySelector(".bardic-inspiration").addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (!isInspired(sheetActor)) return;

        try {
            const formula = getInspirationDie(sheetActor);
            const roll = new Roll(formula);
            await roll.evaluate();

            await roll.toMessage({
                speaker: ChatMessage.getSpeaker({ actor: sheetActor }),
                flavor: `${sheetActor.name} uses their Bardic Inspiration (${formula})`,
            });

            await consumeInspiration(sheetActor);
            refreshOpenPartySheets(sheetActor);
        } catch (err) {
            console.error(`${MODULE_ID} | Bardic Inspiration roll failed`, err);
            ui.notifications.error("Failed to roll Bardic Inspiration.");
        }
    });

    return trackBar;
}

// ============================================================
// UI — PARTY PANEL
// ============================================================

function buildPartyPanel(sheetActor) {
    const partyPanel = document.createElement("div");
    partyPanel.classList.add("party-panel");

    const partyMembers = getPartyMembers(sheetActor);
    if (!partyMembers.length) return partyPanel;

    const listItems = partyMembers.map(member => {
        const inspired = isInspired(member);
        return `
            <li data-actor-id="${member.id}" data-key="${member.name}" title="${inspired ? "Already inspired" : "Click to inspire"}">
                <i class="fas fa-fw${inspired ? " fa-music" : ""}"></i>
                <a class="skill-name">${member.name}</a>
            </li>
        `;
    }).join("");

    partyPanel.innerHTML = `
        <filigree-box class="skills">
            <h3>
                <i class="fas fa-fw fa-music" inert></i>
                <span class="roboto-upper">Party</span>
            </h3>
            <ul>${listItems}</ul>
        </filigree-box>
    `;

    partyPanel.addEventListener("click", async (event) => {
        const li = event.target.closest("li[data-actor-id]");
        if (!li) return;

        event.preventDefault();
        event.stopPropagation();

        const targetActor = game.actors.get(li.dataset.actorId);
        if (!targetActor) return;

        await grantBardicInspiration(sheetActor, targetActor);
        refreshOpenPartySheets(sheetActor);
    });

    return partyPanel;
}

// ============================================================
// INSPIRATION STATE  (flags, not ActiveEffects)
// ============================================================

function isInspired(actor) {
    return actor.getFlag(MODULE_ID, "inspired") === true;
}

async function giveInspiration(actor, sourceActor, bardicDieFormula) {
    await actor.setFlag(MODULE_ID, "inspired", true);
    await actor.setFlag(MODULE_ID, "sourceActorId", sourceActor.id);
    await actor.setFlag(MODULE_ID, "sourceActorName", sourceActor.name);
    await actor.setFlag(MODULE_ID, "inspirationDie", bardicDieFormula);
}

async function consumeInspiration(actor) {
    await actor.setFlag(MODULE_ID, "inspired", false);
    await actor.unsetFlag(MODULE_ID, "sourceActorId");
    await actor.unsetFlag(MODULE_ID, "sourceActorName");
    await actor.unsetFlag(MODULE_ID, "inspirationDie");
}

// ============================================================
// BARDIC INSPIRATION LOGIC
// ============================================================

async function grantBardicInspiration(bardActor, targetActor) {
    if (isInspired(targetActor)) {
        ui.notifications.warn(`${targetActor.name} already has Bardic Inspiration.`);
        return;
    }

    const gmActive = game.users.some(u => u.isGM && u.active);
    if (!gmActive) {
        ui.notifications.warn("A GM must be connected to grant Bardic Inspiration to other players.");
        return;
    }

    const formula = getBardicDie(bardActor);

    const charged = await consumeBardicInspirationCharge(bardActor);
    if (!charged) return;

    try {
        await socket.executeAsGM("giveInspiration", {
            targetActorId: targetActor.id,
            sourceActorId: bardActor.id,
            formula,
        });
    } catch (err) {
        console.error(`${MODULE_ID} | GM execution failed, refunding charge.`, err);
        await refundBardicInspirationCharge(bardActor);
        ui.notifications.error("Failed to grant Bardic Inspiration — charge refunded.");
        return;
    }
    
    const roll = new Roll(formula);
    await roll.evaluate();

    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: bardActor }),
        flavor: `
            <div class="bardic-inspiration-chat" style="text-align: center; padding: 0.25rem 0;">
                <div style="font-size: 1.1rem; font-weight: bold; margin-bottom: 0.35rem;">
                    <i class="fas fa-music"></i>
                    <span style="margin: 0 0.4rem;">Bardic Inspiration</span>
                    <i class="fas fa-music"></i>
                </div>
                <div style="margin-bottom: 0.25rem;">
                    <strong>${bardActor.name}</strong> inspires <strong>${targetActor.name}</strong>
                </div>
                <div style="font-style: italic;">
                    Inspiration Die: <strong>${formula}</strong>
                </div>
            </div>
        `,
    });
}

/**
 * Returns the actor's Bardic Inspiration die formula from dnd5e scale data.
 * Falls back to 1d6 and warns if the scale value cannot be found.
 */
function getBardicDie(actor) {
    const die = actor.getRollData?.()?.scale?.bard?.inspiration;
    if (!die) {
        console.warn(`${MODULE_ID} | Could not find Bardic Inspiration die for ${actor.name}. Defaulting to d6.`);
        ui.notifications.warn(`Could not determine Bardic Inspiration die for ${actor.name}. Using d6.`);
        return "1d6";
    }
    return `1${die}`;
}

/**
 * Alias used when a character is consuming their own stored inspiration die,
 * where the die size was rolled at grant time and stored separately.
 */
function getInspirationDie(actor) {
    // The die was shown in chat at grant time; when consuming we re-roll the
    // same die. Source bard data is no longer needed — just roll a d6 default
    // or any stored formula.
    return actor.getFlag(MODULE_ID, "inspirationDie") ?? "1d6";
}

async function consumeBardicInspirationCharge(bardActor) {
    const feature = bardActor.items.find(
        i => i.type === "feat" && i.name.toLowerCase() === "bardic inspiration"
    );

    if (!feature) {
        console.warn(`${MODULE_ID} | Bardic Inspiration feat not found on ${bardActor.name}.`);
        ui.notifications.warn(`Could not find the Bardic Inspiration feature on ${bardActor.name}.`);
        return false;
    }

    const uses = feature.system?.uses;
    if (!uses || uses.max === 0) {
        // Feature exist but has no uses tracking - let it through silently
        return true;
    }

    if (uses.value <= 0) {
        ui.notifications.warn(`${bardActor.name} has no Bardic Inspiration charges remaining.`);
        return false;
    }

    await feature.update({ "system.uses.spent": uses.spent + 1 });
    return true;
}

// ============================================================
// PARTY DETECTION
// ============================================================

/**
 * Returns party members for the given actor, excluding the actor themselves.
 * Strategy is controlled by the "partyMethod" world setting.
 */
function getPartyMembers(actor) {
    const method = game.settings.get(MODULE_ID, "partyMethod");

    if (method === "scene") {
        const scene = game.scenes?.active;
        if (!scene) return [];
        return scene.tokens
            .filter(t => t.actor && t.actor.type === "character" && t.actor.id !== actor.id)
            .map(t => t.actor);
    }

    // Default: folder
    const folder = actor.folder;
    if (!folder) return [];
    return folder.contents.filter(a => a.type === "character" && a.id !== actor.id);
}

// ============================================================
// SHEET REFRESH HELPERS
// ============================================================

/**
 * Re-renders all open sheets for characters in the same party as changedActor.
 */
function refreshOpenPartySheets(changedActor) {
    console.log(`${MODULE_ID} | Refreshing party sheets for: ${changedActor.name}`);

    const method = game.settings.get(MODULE_ID, "partyMethod");
    let partyMembers;

    if (method === "scene") {
        partyMembers = [changedActor, ...getPartyMembers(changedActor)];
    } else {
        const folderId = changedActor?.folder?.id;
        if (!folderId) return;
        partyMembers = game.actors.filter(
            a => a.type === "character" && a.folder?.id === folderId
        );
    }

    for (const actor of partyMembers) {
        for (const app of Object.values(actor.apps ?? {})) {
            app.render(false);
        }
    }
}

/**
 * Re-renders all open character sheets. Used when folder membership changes.
 */
function refreshAllOpenCharacterSheets() {
    for (const actor of game.actors.filter(a => a.type === "character")) {
        for (const app of Object.values(actor.apps ?? {})) {
            app.render(false);
        }
    }
}

async function refundBardicInspirationCharge(bardActor) {
    const feature = bardActor.items.find(
        i => i.type === "feat" && i.name.toLowerCase() === "bardic inspiration"
    );
    if (!feature) return;
    const uses = feature.system?.uses;
    if (!uses || uses.max === 0) return;
    await feature.update({ "system.uses.spent": Math.max(0, uses.spent - 1) });
}

// ============================================================
// SOCKET
// ============================================================

async function handleGiveInspiration({ targetActorId, sourceActorId, formula }) {
    const targetActor = game.actors.get(targetActorId);
    const sourceActor = game.actors.get(sourceActorId);
    if (!targetActor || !sourceActor) return;
    await giveInspiration(targetActor, sourceActor, formula);
    refreshOpenPartySheets(targetActor);
}
