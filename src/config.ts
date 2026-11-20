// Gameplay constants, ported from the original LÖVE source (main.lua / gameA.lua).
// The original works in "physics pixels": 32 px per block, 30 px per Box2D meter.
// Positions here stay in those pixels; forces/torques are given in SI units
// (the original's 70*meter etc. after LÖVE's internal pixel->meter scaling).

export const PX_PER_M = 30;
export const BLOCK = 32;
export const BLOCK_AREA = BLOCK * BLOCK;
export const ROWS = 18;
export const FIELD_HEIGHT = ROWS * BLOCK; // 576

export const GRAVITY = 500; // px/s²
export const SIDE_FORCE = 70; // N   (blockforce = 70*meter)
export const DOWN_FORCE = 20; // N   (blockdownforce = 20*meter)
export const TORQUE = 70; // N·m (blocktorque = 70*meter*meter)
export const MAX_SPIN = 3; // rad/s, torque only applied below this
export const SPIN_EASE = 1; // rad/s: the analog spin control eases off its torque within this of its target
// 90° rotation (Settings.rotation): each press turns the falling piece a quarter turn, which it
// swings through at up to QUARTER_SPIN and then holds, instead of spinning freely under torque.
export const QUARTER_SPIN = 15; // rad/s, a quarter turn takes about 0.1 s
export const QUARTER_GAIN = 20; // 1/s, angular speed per radian still to turn
export const QUARTER_PRESS = 0.5; // the touch spin slider presses past this far out of 1...
export const QUARTER_RELEASE = 0.25; // ...and lets go again back inside this
export const BASE_SPEED = 100; // px/s fall speed at level 0
export const SPEED_PER_LEVEL = 7; // px/s per level
export const MAX_DROP_SPEED = 500; // px/s while holding down
export const FALL_BRAKE = 2000; // px/s² braking back to fall speed

export const LINEAR_DAMPING = 0.5;
export const FRICTION = 0.5;
export const RESTITUTION = 0.1;
export const WALL_FRICTION = 0.00001;
export const DENSITY = 1;
export const MIN_MASS = 1; // kg, fragments never get lighter than this
export const FIXTURE_SHRINK = 0.01 * PX_PER_M; // Box2D polygon skin, so blocks visually touch
export const MIN_SIDE_DIST = 0.04 * PX_PER_M; // polygons thinner than this are discarded

export const CLEAR_THRESHOLD = 8.1; // row is cut when it holds this many blocks' worth of area
export const CLEAR_DURATION = 1.2; // s
export const CLEAR_BLINKS = 7;
export const DENSITY_INTERVAL = 1 / 30; // s between row-fill meter updates
export const SCORE_POPUP_TIME = 0.5; // s
export const NEXT_SPIN_SPEED = 1; // rad/s, the preview piece slowly turns
// The physics T-spin (a joke: real T-spins can't happen here): a falling T turning a full circle,
// at most once per piece, pays this.
export const TSPIN_POINTS = 100;
export const TSPIN_POPUP_TIME = 1.2; // s the T-SPIN! label blinks

export const SPAWN_X = 224;
export const SPAWN_Y = -64;
export const LOSING_Y = 0; // landing with the piece centre above this line ends the game
export const FALLOUT_Y = 648; // game over screen once every piece has dropped below this

// Versus and Online attacks (Field.receiveAttack). Cutting rows sends the other player single blocks:
// ATTACK_BLOCKS[n] for n rows at once (the last entry for more). They wait at the top of their
// column until a whole piece has landed after they came, then drop on the next landing that cuts
// nothing, between pieces: the next piece waits until they are down. A cut first cancels blocks
// still waiting, and only the rest is sent.
export const ATTACK_BLOCKS = [0, 1, 2, 3, 5];
export const GARBAGE_SLOTS = 10; // columns a block can drop in, evenly across the well
export const GARBAGE_MAX_DROP = 6; // blocks dropping on one landing; more wait for the next
export const GARBAGE_MAX_QUEUE = 20; // blocks waiting at most; more are lost
export const GARBAGE_SPAWN_Y = -96; // above the well, below the ceiling
export const GARBAGE_DROP_SPEED = 600; // px/s, top falling speed of a dropped block
export const GARBAGE_SPAWN_WAIT = 1.5; // s, longest the next piece waits for dropped blocks to land

export const STEP = 1 / 60;
// The original passes 10/10 to LÖVE's Box2D. planck.js needs more to hold up a tall pile of small
// cut fragments: at 10/10 heavy pieces sink into the crumbs below them (up to 60 px) and then shove
// everything apart, so the pile starts to jump. 20/20 removed that in every test game.
export const VELOCITY_ITERATIONS = 20;
// Settled pieces only get continuous collision while moving faster than this, in px/s (Field.updateBullets).
export const BULLET_SPEED = 60;
export const POSITION_ITERATIONS = 20;
