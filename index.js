const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const port = process.env.PORT || 3000;

app.use(express.static('public'));

const paths = require('./paths.json');

const { Engine, Runner, Body, Common,
  Vertices, Events, Bodies, Composite } = require('matter-js');

// provide concave decomposition support library
Common.setDecomp(require('poly-decomp'));

// create an engine and physics world
const engine = Engine.create(),
  world = engine.world;

// run the engine
const runner = Runner.create();
Runner.run(runner, engine);

// add terrain
Composite.add(world,
  Bodies.fromVertices(0, 0,
    Vertices.fromPath(paths['terrain']),
    { isStatic: true },
  ),
);

// create composite for dynamic bodies for fast access
const dynamic = Composite.create();
Composite.add(world, dynamic);

// generate npcs, chests, loot
['chest', 'sword', 'shield', 'worm', 'token'].forEach(kind => {
  const body = Bodies.fromVertices(-400 + 800 * Math.random(), -1000,
    Vertices.fromPath(paths[kind]),
    {
      mass: 0.2,
      friction: 0.01,
    }
  );
  body.kind = kind;
  Composite.add(dynamic, body);
});

// map player.id (used internally) to socket.id (used to communicate)
const socketIds = new Map();

let playerCount = 0;

io.on('connection', socket => {
  // connection means player has joined game
  console.log(`New player! Player count: ${++playerCount}`);

  // create player
  const arrow = Vertices.fromPath(paths['player']);
  const player = Bodies.fromVertices(0, -300, arrow, {
    mass: 0.5,
    friction: 0.01,
  });
  player.kind = 'player'; // every dynamic body needs kind
  player.controls = {};
  player.health = 100;
  player.tokens = 1;
  player.sword = 0;
  player.shield = 0;

  // get nickname (sent immediatly after connection)
  socket.on('nickname', nn => player.nickname = nn);

  // emit 'add' for every dynamic body
  dynamic.bodies.forEach(body => socket.emit('add', body.id, body.kind));

  Composite.add(dynamic, player); // add player
  io.emit('add', player.id, 'player'); // let everyone know player was added

  socket.emit('id', player.id); // send id

  socketIds.set(player.id, socket.id) // record socket.id

  // listen for input
  // update control state
  socket.on('input', code => {
    const control = code.toLowerCase();
    const active = control === code;
    player.controls[control] = active;
  });

  // move player according to control state
  Events.on(engine, 'beforeUpdate', () => {
    const {a, d, l} = player.controls;
    const t = 0.04, f = 0.0015; // magnitudes

    if (a) player.torque = -t;
    if (d) player.torque = t;

    if (l) player.force = {
      x: f * Math.sin(player.angle),
      y: -f * Math.cos(player.angle)
    };
  });

  socket.on('disconnect', () => {
    // disconnect means player has left game
    console.log(`Player left! Player count: ${--playerCount}`);

    Composite.remove(dynamic, player); // remove player
    io.emit('remove', player.id); // let everyone know player was removed

    socketIds.delete(player.id) // forget socket.id
  });
});

// emit regular updates to clients
// extract and broadcast gamestate
// update dynamic bodies
setInterval(() => {
  const gamestate = dynamic.bodies.map(body => ({
    i: body.id,
    x: Math.round(body.position.x),
    y: Math.round(body.position.y),
    r: Math.round(body.angle * 100) / 100,
  }));

  io.volatile.emit('update', gamestate);
}, 1000 / 30);

// infrequently emit leaderboard to all clients
setInterval(() => {
  const players = dynamic.bodies.filter(
    body => body.kind === 'player'
  );

  players.sort((a, b) => b.tokens - a.tokens);

  const top = players.slice(0, 3);

  for (const [playerId, socketId] of socketIds) {
    const you = players.find(player => player.id === playerId);

    const leaderboard = top.includes(you) ? top : top.concat(you);

    io.to(socketId).emit('leaderboard', leaderboard.map(
      ({ nickname, tokens }) => ({ nickname, tokens })
    ));
  }
}, 3000);

// listen for collisions
Events.on(engine, "collisionStart", ({ pairs }) => {
  for (const {bodyA, bodyB, activeContacts, collision} of pairs) {
    // both bodies must be players
    if (!bodyA.controls || !bodyB.controls) continue;

    // must be a stab with nose
    if (activeContacts.length != 1) continue;
    const { vertex } = activeContacts[0];
    if (vertex.index != 0) continue;

    // identify attacker and victim
    const attacker = vertex.body;
    const victim = attacker === bodyA ? bodyB : bodyA;

    if (victim.stabImmune) return; // return if shielded

    // make victim immune to stab for 0.5 seconds
    victim.stabImmune = true;
    setTimeout(() => victim.stabImmune = false, 500);

    // compute damage
    const damage = Math.round(collision.depth * 5);

    strike(attacker, damage, [{
      x: Math.round(vertex.x),
      y: Math.round(vertex.y),
    }]);
    injury(victim, damage, attacker);
  }
});

function strike(player, amount, positions) {
  // emit 'strike' with damage dealt and position
  io.to(socketIds.get(player.id)).emit('strike', amount, positions);
}

function injury(player, amount, attacker) {
  // decrement victim health
  player.health -= amount;

  // check if dead
  if (player.health <= 0) {
    player.health = 100;
    Body.setPosition(player, { x: 400, y: 100 });
    attacker.tokens += 1;
  }

  // emit 'injury' with new health
  io.to(socketIds.get(player.id)).emit('injury', player.health);
}

http.listen(port, () => console.log(`Listening on port ${port}`));
