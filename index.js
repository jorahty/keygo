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
    { friction: 0.01, isStatic: true },
  ),
);

// create composite for dynamic bodies for
// fast access when extracting gamestate
const dynamic = Composite.create();
Composite.add(world, dynamic);

// generate npcs, chests, loot
['chest', 'sword', 'shield', 'worm', 'token'].forEach(kind => {
  const body = Bodies.fromVertices(-400 + 800 * Math.random(), -1000,
    Vertices.fromPath(paths[kind]), {
      mass: 0.1,
      friction: 0.001,
    }
  );
  body.kind = kind;
  body.class = ['worm', 'chest'].includes(kind) ? 'entity' : 'loot';
  Composite.add(dynamic, body);
});

// map player.id (used internally) to socket.id (used to communicate)
const socketIds = new Map();

let playerCount = 0;

io.on('connection', socket => {
  // connection means player has joined game
  console.log(`New player! Player count: ${++playerCount}`);

  // create player
  const player = Bodies.fromVertices(0, -1000,
    Vertices.fromPath(paths['player']), {
    mass: 0.5,
    friction: 0.01,
  });
  player.class = 'entity'; // every dynamic body needs class (for collision type)
  player.kind = 'player'; // every dynamic body needs kind
  player.controls = {};
  player.health = 100;
  player.token = 1;
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
    const { a, d, l } = player.controls;
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

    popPlayer(player);

    socketIds.delete(player.id) // forget socket.id
  });
});

// emit regular updates to clients
// extract and broadcast gamestate
// send dynamic bodies update
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

  players.sort((a, b) => b.token - a.token);

  const top = players.slice(0, 3);

  // send each player their custom leaderboard
  for (const [playerId, socketId] of socketIds) {
    const you = players.find(player => player.id === playerId);

    const leaderboard = top.includes(you) || !you ? top : top.concat(you);

    io.to(socketId).emit('leaderboard', leaderboard.map(
      ({ nickname, token }) => ({ nickname, token })
    ));
  }
}, 3000);

// listen for collisions
Events.on(engine, "collisionStart", ({ pairs }) => {
  for (const {bodyA, bodyB, activeContacts, collision} of pairs) {
    // if neither is player, skip
    if (!(bodyA.kind === 'player' || bodyB.kind === 'player')) continue;

    // if other is loot, handle upgrade
    if (bodyA.class === 'loot') {
      handleUpgrade(bodyB, bodyA);
      continue;
    }
    if (bodyB.class === 'loot') { 
      handleUpgrade(bodyA, bodyB);
      continue;
    }

    // if other is entity, handle stab
    if (bodyA.class === 'entity' || bodyB.class === 'entity') {
      handleStab(bodyA, bodyB, activeContacts, collision);
    }
  }
});

function handleUpgrade(player, loot) {
  player[loot.kind]++ // upgrade player

  // inform player of their upgrade
  io.to(socketIds.get(player.id)).emit('upgrade', loot.kind, player[loot.kind]);

  Composite.remove(dynamic, loot); // remove loot from world
  io.emit('remove', loot.id); // let everyone know loot was removed
}

function handleStab(bodyA, bodyB, activeContacts, collision) {
  // both bodies must be players
  if (!bodyA.controls || !bodyB.controls) return;

  // must be a stab with nose
  if (activeContacts.length != 1) return;
  const { vertex } = activeContacts[0];
  if (vertex.index != 0) return;

  // identify attacker and victim
  const attacker = vertex.body;
  const victim = attacker === bodyA ? bodyB : bodyA;

  if (victim.stabImmune) return; // return if immune

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

function strike(player, amount, positions) {
  // emit 'strike' with damage dealt and positions
  io.to(socketIds.get(player.id)).emit('strike', amount, positions);
}

function injury(player, amount, attacker) {
  // decrement victim health
  player.health -= amount;

  // check if dead
  if (player.health <= 0) {
    popPlayer(player);
    
    io.to(socketIds.get(player.id)).emit('death', attacker.nickname);
    io.to(socketIds.get(attacker.id)).emit('kill', player.nickname);

    // respawn after 3 seconds
    setTimeout(() => {
      Composite.add(dynamic, player, {id: player.id});
      io.emit('add', player.id, 'player'); // let everyone know player was added
      player.health = 100;
      player.token = 1;
      player.sword = player.shield = 0;
      Body.setPosition(player, { x: 0, y: -500 });
    }, 3000);

    return;
  }

  // emit 'injury' with new health
  io.to(socketIds.get(player.id)).emit('injury', player.health);
}

// remove player from world and emit 'remove'
// add items to world and emit 'add'
function popPlayer(entity) {
  Composite.remove(dynamic, entity); // remove player
  io.emit('remove', entity.id); // let everyone know player was removed
  
  const { x, y } = entity.position;

  const addLoot = (kind) => {
    const token = Bodies.fromVertices(x, y,
      Vertices.fromPath(paths[kind]), {
        mass: 0.1,
        friction: 0.001,
      }
    );
    token.kind = kind;
    token.class = 'loot';
    Composite.add(dynamic, token);
    io.emit('add', token.id, kind);
  }

  for (let i = 0; i < entity.token; i++) addLoot('token'); // add tokens
  if (entity.sword > 0) addLoot('sword'); // add sword
  if (entity.shield > 0) addLoot('shield'); // add shield
}

http.listen(port, () => console.log(`Listening on port ${port}`));
