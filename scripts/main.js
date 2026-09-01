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


// ============================================================
// BARDIC INSPIRATION PRE-ROLL HOOKS
// ============================================================

// Skill checks
Hooks.on("dnd5e.preRollSkill", (config, dialog, message) => {
    return handleBardicPreRoll(config, dialog, message);
});

// Ability checks
Hooks.on("dnd5e.preRollAbilityCheck", (config, dialog, message) => {
    return handleBardicPreRoll(config, dialog, message);
});

// Saving throws
Hooks.on("dnd5e.preRollSavingThrow", (config, dialog, message) => {
    return handleBardicPreRoll(config, dialog, message);
});


// ============================================================
// ACTOR SHEET
// ============================================================

Hooks.on("renderActorSheetV2", (app, html) => {
    const actor = app.actor ?? app.document;

    if (!actor || actor.type !== "character") return;

    const root = html instanceof jQuery ? html[0] : html;

    if (!root) return;

    const sheetBody = root.querySelector(".window-content") ?? root;


    // --------------------------------------------------------
    // TRACK BAR
    // --------------------------------------------------------

    const trackBar = buildTrackBar(actor);

    const sheetHeader =
        sheetBody.querySelector(".sheet-header") ??
        sheetBody;

    const sheetLeftDiv =
        sheetHeader.querySelector(".left") ??
        sheetHeader;

    sheetLeftDiv.prepend(trackBar);


    // --------------------------------------------------------
    // PARTY PANEL
    // --------------------------------------------------------

    const isBard = actor.items.some(
        i =>
            i.type === "class" &&
            i.name.toLowerCase() === "bard"
    );

    if (isBard) {
        const partyPanel = buildPartyPanel(actor);

        const rightDetailsTab =
            sheetBody.querySelector(
                'section.tab[data-tab="details"][data-group="primary"] > .right'
            ) ??
            sheetBody;

        rightDetailsTab.append(partyPanel);
    }
});


// ============================================================
// ACTOR UPDATE HOOKS
// ============================================================

Hooks.on("createActor", actor => {
    if (actor.type !== "character") return;

    refreshOpenPartySheets(actor);
});


Hooks.on("updateActor", (actor, changed) => {
    if (actor.type !== "character") return;

    if (Object.hasOwn(changed, "folder")) {
        refreshAllOpenCharacterSheets();
        return;
    }

    refreshOpenPartySheets(actor);
});


Hooks.on("deleteActor", actor => {
    if (actor.type !== "character") return;

    refreshOpenPartySheets(actor);
});


// ============================================================
// REST HOOKS
// ============================================================

Hooks.on("dnd5e.shortRest", actor => {
    consumeInspiration(actor);
});

Hooks.on("dnd5e.longRest", actor => {
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
            data-tooltip="Bardic Inspiration available. It will be offered on your next eligible roll."
        >
            <i class="fas fa-music"></i>
        </button>
    `;


    // --------------------------------------------------------
    // The button is now an indicator rather than a roll button.
    // Inspiration is automatically offered during eligible rolls.
    // --------------------------------------------------------

    trackBar
        .querySelector(".bardic-inspiration")
        ?.addEventListener("click", event => {

            event.preventDefault();
            event.stopPropagation();

            ui.notifications.info(
                "Bardic Inspiration will be offered automatically when you make an eligible roll."
            );
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

    if (!partyMembers.length) {
        return partyPanel;
    }


    const listItems = partyMembers
        .map(member => {

            const inspired = isInspired(member);

            return `
                <li
                    data-actor-id="${member.id}"
                    data-key="${member.name}"
                    title="${
                        inspired
                            ? "Already inspired"
                            : "Click to inspire"
                    }"
                >
                    <i class="fas fa-fw${
                        inspired
                            ? " fa-music"
                            : ""
                    }"></i>

                    <a class="skill-name">
                        ${member.name}
                    </a>
                </li>
            `;
        })
        .join("");


    partyPanel.innerHTML = `
        <filigree-box class="skills">

            <h3>
                <i
                    class="fas fa-fw fa-music"
                    inert
                ></i>

                <span class="roboto-upper">
                    Party
                </span>
            </h3>

            <ul>
                ${listItems}
            </ul>

        </filigree-box>
    `;


    // --------------------------------------------------------
    // PARTY MEMBER CLICK
    // --------------------------------------------------------

    partyPanel.addEventListener("click", async event => {

        const li = event.target.closest(
            "li[data-actor-id]"
        );

        if (!li) return;

        event.preventDefault();
        event.stopPropagation();


        const targetActor =
            game.actors.get(
                li.dataset.actorId
            );

        if (!targetActor) return;


        // Give Inspiration ONLY.
        //
        // IMPORTANT:
        // This no longer rolls the Inspiration die.
        //

        await grantBardicInspiration(
            sheetActor,
            targetActor
        );


        refreshOpenPartySheets(sheetActor);
    });


    return partyPanel;
}


// ============================================================
// INSPIRATION STATE
// ============================================================

function isInspired(actor) {

    return actor.getFlag(
        MODULE_ID,
        "inspired"
    ) === true;
}


// ------------------------------------------------------------
// Give Inspiration
// ------------------------------------------------------------

async function giveInspiration(
    actor,
    sourceActor,
    bardicDieFormula
) {

    await actor.setFlag(
        MODULE_ID,
        "inspired",
        true
    );

    await actor.setFlag(
        MODULE_ID,
        "sourceActorId",
        sourceActor.id
    );

    await actor.setFlag(
        MODULE_ID,
        "sourceActorName",
        sourceActor.name
    );

    await actor.setFlag(
        MODULE_ID,
        "inspirationDie",
        bardicDieFormula
    );
}


// ------------------------------------------------------------
// Consume Inspiration
// ------------------------------------------------------------

async function consumeInspiration(actor) {

    await actor.setFlag(
        MODULE_ID,
        "inspired",
        false
    );

    await actor.unsetFlag(
        MODULE_ID,
        "sourceActorId"
    );

    await actor.unsetFlag(
        MODULE_ID,
        "sourceActorName"
    );

    await actor.unsetFlag(
        MODULE_ID,
        "inspirationDie"
    );
}


// ============================================================
// BARDIC INSPIRATION
// ============================================================

async function grantBardicInspiration(
    bardActor,
    targetActor
) {

    // --------------------------------------------------------
    // Already Inspired?
    // --------------------------------------------------------

    if (isInspired(targetActor)) {

        ui.notifications.warn(
            `${targetActor.name} already has Bardic Inspiration.`
        );

        return;
    }


    // --------------------------------------------------------
    // Make sure a GM is connected
    // --------------------------------------------------------

    const gmActive =
        game.users.some(
            user =>
                user.isGM &&
                user.active
        );


    if (!gmActive) {

        ui.notifications.warn(
            "A GM must be connected to grant Bardic Inspiration to other players."
        );

        return;
    }


    // --------------------------------------------------------
    // Determine the Bard's Inspiration die
    // --------------------------------------------------------

    const formula =
        getBardicDie(bardActor);


    // --------------------------------------------------------
    // Consume one Bardic Inspiration charge
    // --------------------------------------------------------

    const charged =
        await consumeBardicInspirationCharge(
            bardActor
        );


    if (!charged) return;


    // --------------------------------------------------------
    // Give Inspiration through GM
    // --------------------------------------------------------

    try {

        await socket.executeAsGM(
            "giveInspiration",
            {
                targetActorId:
                    targetActor.id,

                sourceActorId:
                    bardActor.id,

                formula,
            }
        );

    } catch (err) {

        console.error(
            `${MODULE_ID} | GM execution failed, refunding charge.`,
            err
        );

        await refundBardicInspirationCharge(
            bardActor
        );

        ui.notifications.error(
            "Failed to grant Bardic Inspiration — charge refunded."
        );

        return;
    }


    // --------------------------------------------------------
    // IMPORTANT:
    //
    // DO NOT ROLL HERE.
    //
    // The recipient will decide whether to use
    // Bardic Inspiration when they make a roll.
    // --------------------------------------------------------

    await ChatMessage.create({

        speaker:
            ChatMessage.getSpeaker({
                actor: bardActor
            }),

        content: `

            <div
                class="bardic-inspiration-chat"
                style="
                    text-align:center;
                    padding:0.25rem 0;
                "
            >

                <div
                    style="
                        font-size:1.1rem;
                        font-weight:bold;
                        margin-bottom:0.35rem;
                    "
                >

                    <i class="fas fa-music"></i>

                    <span style="margin:0 0.4rem;">
                        Bardic Inspiration
                    </span>

                    <i class="fas fa-music"></i>

                </div>


                <div style="margin-bottom:0.25rem;">

                    <strong>
                        ${bardActor.name}
                    </strong>

                    inspires

                    <strong>
                        ${targetActor.name}
                    </strong>

                </div>


                <div style="font-style:italic;">

                    Inspiration Die:

                    <strong>
                        ${formula}
                    </strong>

                </div>

            </div>
        `,
    });
}


// ============================================================
// PRE-ROLL INSPIRATION PROMPT
// ============================================================

function handleBardicPreRoll(
    config,
    dialog,
    message
) {

    if (!config) return;


    // Don't intercept our own rerolled roll.
    if (config._bardicInspirationHandled) {
        return;
    }


    // --------------------------------------------------------
    // Find the actor making the roll
    // --------------------------------------------------------

    const actor = config.actor;

    if (!actor) return;


    // --------------------------------------------------------
    // Does this character have Inspiration?
    // --------------------------------------------------------

    if (!isInspired(actor)) {
        return;
    }


    // --------------------------------------------------------
    // Get the stored Inspiration die
    // --------------------------------------------------------

    const formula =
        getInspirationDie(actor);

    if (!formula) return;


    // --------------------------------------------------------
    // Stop the original roll.
    //
    // We'll ask the player first.
    // --------------------------------------------------------

    promptForBardicInspiration(
        actor,
        config,
        dialog,
        message,
        formula
    );


    return false;
}


// ============================================================
// BARDIC INSPIRATION PROMPT
// ============================================================

async function promptForBardicInspiration(
    actor,
    config,
    dialog,
    message,
    formula
) {

    try {

        let useInspiration = false;


        // ----------------------------------------------------
        // Foundry V13 DialogV2
        // ----------------------------------------------------

        const DialogClass =
            foundry.applications?.api?.DialogV2;


        if (DialogClass?.confirm) {

            useInspiration =
                await DialogClass.confirm({

                    window: {
                        title:
                            "Bardic Inspiration"
                    },


                    content: `

                        <p>
                            <strong>
                                ${actor.name}
                            </strong>
                            has Bardic Inspiration available.
                        </p>

                        <p>
                            Would you like to add
                            <strong>
                                ${formula}
                            </strong>
                            to this roll?
                        </p>

                    `,


                    rejectClose: false,

                    modal: true,
                });

        }


        // ----------------------------------------------------
        // Fallback for older Dialog API
        // ----------------------------------------------------

        else if (Dialog?.confirm) {

            useInspiration =
                await Dialog.confirm({

                    title:
                        "Bardic Inspiration",

                    content: `

                        <p>
                            <strong>
                                ${actor.name}
                            </strong>
                            has Bardic Inspiration available.
                        </p>

                        <p>
                            Would you like to add
                            <strong>
                                ${formula}
                            </strong>
                            to this roll?
                        </p>

                    `,

                    defaultYes: false,
                });
        }


        // ----------------------------------------------------
        // NO
        // ----------------------------------------------------

        if (!useInspiration) {

            await rerollWithoutBardicInspiration(
                actor,
                config,
                dialog,
                message
            );

            return;
        }


        // ----------------------------------------------------
        // YES
        // ----------------------------------------------------

        await rerollWithBardicInspiration(
            actor,
            config,
            dialog,
            message,
            formula
        );


    } catch (err) {

        console.error(
            `${MODULE_ID} | Bardic Inspiration prompt failed`,
            err
        );

        ui.notifications.error(
            "Bardic Inspiration prompt failed; the original roll was not made."
        );
    }
}


// ============================================================
// NORMAL ROLL — NO INSPIRATION
// ============================================================

async function rerollWithoutBardicInspiration(
    actor,
    config,
    dialog,
    message
) {

    const rerollConfig =
        foundry.utils.deepClone(config);


    // Prevent this roll from being intercepted again.
    rerollConfig._bardicInspirationHandled =
        true;


    const rerollDialog =
        foundry.utils.deepClone(
            dialog ?? {}
        );


    // Don't show the roll configuration
    // dialog a second time.
    rerollDialog.configure = false;


    const rerollMessage =
        foundry.utils.deepClone(
            message ?? {}
        );


    await CONFIG.Dice.D20Roll.build(
        rerollConfig,
        rerollDialog,
        rerollMessage
    );
}


// ============================================================
// ROLL WITH BARDIC INSPIRATION
// ============================================================

async function rerollWithBardicInspiration(
    actor,
    config,
    dialog,
    message,
    formula
) {

    const rerollConfig =
        foundry.utils.deepClone(config);


    // Prevent our replacement roll from
    // triggering the Inspiration prompt again.
    rerollConfig._bardicInspirationHandled =
        true;


    // --------------------------------------------------------
    // Add Inspiration to every roll configuration.
    //
    // This preserves the normal D&D 5e roll:
    //
    // d20
    // + ability modifier
    // + proficiency
    // + expertise
    // + other modifiers
    //
    // and simply adds:
    //
    // + 1d8
    // --------------------------------------------------------

    if (
        !Array.isArray(
            rerollConfig.rolls
        ) ||
        !rerollConfig.rolls.length
    ) {

        console.error(
            `${MODULE_ID} | Could not find pending roll configuration.`,
            rerollConfig
        );

        ui.notifications.error(
            "Could not add Bardic Inspiration to this roll."
        );

        return;
    }


    for (
        const rollConfig
        of rerollConfig.rolls
    ) {

        rollConfig.parts ??= [];

        rollConfig.parts.push(
            formula
        );
    }


    const rerollDialog =
        foundry.utils.deepClone(
            dialog ?? {}
        );


    rerollDialog.configure = false;


    const rerollMessage =
        foundry.utils.deepClone(
            message ?? {}
        );


    // --------------------------------------------------------
    // Make the modified D&D 5e roll.
    // --------------------------------------------------------

    await CONFIG.Dice.D20Roll.build(
        rerollConfig,
        rerollDialog,
        rerollMessage
    );


    // --------------------------------------------------------
    // Consume Inspiration AFTER the player chose YES.
    // --------------------------------------------------------

    await consumeInspiration(
        actor
    );


    refreshOpenPartySheets(
        actor
    );
}


// ============================================================
// BARDIC INSPIRATION DIE
// ============================================================

function getBardicDie(actor) {

    const die =
        actor
            .getRollData?.()
            ?.scale
            ?.bard
            ?.inspiration;


    if (!die) {

        console.warn(
            `${MODULE_ID} | Could not find Bardic Inspiration die for ${actor.name}. Defaulting to d6.`
        );

        ui.notifications.warn(
            `Could not determine Bardic Inspiration die for ${actor.name}. Using d6.`
        );

        return "1d6";
    }


    return `1${die}`;
}


// ------------------------------------------------------------
// Get stored Inspiration die
// ------------------------------------------------------------

function getInspirationDie(actor) {

    return actor.getFlag(
        MODULE_ID,
        "inspirationDie"
    ) ?? "1d6";
}


// ============================================================
// BARDIC INSPIRATION CHARGE
// ============================================================

async function consumeBardicInspirationCharge(
    bardActor
) {

    const feature =
        bardActor.items.find(
            item =>
                item.type === "feat" &&
                item.name
                    .toLowerCase() ===
                    "bardic inspiration"
        );


    if (!feature) {

        console.warn(
            `${MODULE_ID} | Bardic Inspiration feat not found on ${bardActor.name}.`
        );

        ui.notifications.warn(
            `Could not find the Bardic Inspiration feature on ${bardActor.name}.`
        );

        return false;
    }


    const uses =
        feature.system?.uses;


    if (
        !uses ||
        uses.max === 0
    ) {

        // Feature doesn't have
        // use tracking.
        return true;
    }


    if (
        uses.value <= 0
    ) {

        ui.notifications.warn(
            `${bardActor.name} has no Bardic Inspiration charges remaining.`
        );

        return false;
    }


    await feature.update({
        "system.uses.spent":
            uses.spent + 1
    });


    return true;
}


// ============================================================
// REFUND CHARGE
// ============================================================

async function refundBardicInspirationCharge(
    bardActor
) {

    const feature =
        bardActor.items.find(
            item =>
                item.type === "feat" &&
                item.name
                    .toLowerCase() ===
                    "bardic inspiration"
        );


    if (!feature) return;


    const uses =
        feature.system?.uses;


    if (
        !uses ||
        uses.max === 0
    ) {
        return;
    }


    await feature.update({

        "system.uses.spent":
            Math.max(
                0,
                uses.spent - 1
            )
    });
}


// ============================================================
// PARTY DETECTION
// ============================================================

function getPartyMembers(actor) {

    const method =
        game.settings.get(
            MODULE_ID,
            "partyMethod"
        );


    // --------------------------------------------------------
    // ACTIVE SCENE TOKENS
    // --------------------------------------------------------

    if (method === "scene") {

        const scene =
            game.scenes?.active;


        if (!scene) return [];


        return scene.tokens

            .filter(
                token =>
                    token.actor &&
                    token.actor.type ===
                        "character" &&
                    token.actor.id !==
                        actor.id
            )

            .map(
                token =>
                    token.actor
            );
    }


    // --------------------------------------------------------
    // SAME FOLDER
    // --------------------------------------------------------

    const folder =
        actor.folder;


    if (!folder) {
        return [];
    }


    return folder.contents.filter(
        character =>
            character.type ===
                "character" &&
            character.id !==
                actor.id
    );
}


// ============================================================
// SHEET REFRESH
// ============================================================

function refreshOpenPartySheets(
    changedActor
) {

    console.log(
        `${MODULE_ID} | Refreshing party sheets for: ${changedActor.name}`
    );


    const method =
        game.settings.get(
            MODULE_ID,
            "partyMethod"
        );


    let partyMembers;


    if (method === "scene") {

        partyMembers = [
            changedActor,
            ...getPartyMembers(
                changedActor
            )
        ];

    } else {

        const folderId =
            changedActor
                ?.folder
                ?.id;


        if (!folderId) return;


        partyMembers =
            game.actors.filter(
                actor =>
                    actor.type ===
                        "character" &&
                    actor.folder?.id ===
                        folderId
            );
    }


    for (
        const actor
        of partyMembers
    ) {

        for (
            const app
            of Object.values(
                actor.apps ?? {}
            )
        ) {

            app.render(false);
        }
    }
}


// ============================================================
// REFRESH ALL CHARACTER SHEETS
// ============================================================

function refreshAllOpenCharacterSheets() {

    for (
        const actor
        of game.actors.filter(
            actor =>
                actor.type ===
                "character"
        )
    ) {

        for (
            const app
            of Object.values(
                actor.apps ?? {}
            )
        ) {

            app.render(false);
        }
    }
}


// ============================================================
// SOCKET — GM SIDE
// ============================================================

async function handleGiveInspiration({
    targetActorId,
    sourceActorId,
    formula
}) {

    const targetActor =
        game.actors.get(
            targetActorId
        );


    const sourceActor =
        game.actors.get(
            sourceActorId
        );


    if (
        !targetActor ||
        !sourceActor
    ) {
        return;
    }


    await giveInspiration(
        targetActor,
        sourceActor,
        formula
    );


    refreshOpenPartySheets(
        targetActor
    );
}
