const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const port = process.env.PORT || 3000;

app.use(express.static('public'));

const paths = require('./paths.json');

const { Engine, Runner, Body, Common, Sleeping,
  Vertices, Events, Bodies, Composite } = require('matter-js');

// provide concave decomposition support library
Common.setDecomp(require('poly-decomp'));

// create an engine and physics world
const engine = Engine.create({ enableSleeping: true }),
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

// create composite for dynamic bodies
const dynamic = Composite.create();
Composite.add(world, dynamic);

// create composite for loot (bags)
const loot = Composite.create();
Composite.add(world, loot);

// generate dynamic bodies
[1,2,3,4,5].forEach(() => {
  const kind = Math.random() > 0.5 ? 'worm' : 'chest';
  const body = Bodies.fromVertices(-400 + 800 * Math.random(), -600,
    Vertices.fromPath(paths[kind]), {
      mass: 0.1,
      friction: 0.001,
    }
  );
  body.kind = kind;
  body.class = 'entity'; // for collision type
  Composite.add(dynamic, body);
});

// generate loot
[1,2,3,4,5,6,7,8,9].forEach(() => {
  const body = Bodies.fromVertices(-400 + 800 * Math.random(), -600 * Math.random(),
    Vertices.fromPath(paths['bag']), {
      mass: 0.1,
      friction: 0.001,
      isStatic: true,
      isSensor: true,
    }
  );
  body.kind = 'bag';
  body.class = 'loot'; // for collision type
  body.points = Math.floor(Math.random() * 30);
  body.sword = Math.floor(Math.random() * 4);
  body.shield = Math.floor(Math.random() * 4);
  body.isAvailable = true
  Composite.add(loot, body);
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
  player.points = 1;
  player.sword = 0;
  player.shield = 0;

  // get nickname (sent immediatly after connection)
  socket.on('nickname', nn => player.nickname = nn);

  // emit 'add' for every preexisting body
  dynamic.bodies.forEach(body => socket.emit('add', body.id, body.kind, body.position));
  loot.bodies.forEach(body => socket.emit('add', body.id, body.kind, body.position));

  Composite.add(dynamic, player); // add player
  io.emit('add', player.id, 'player', player.position); // let everyone know player was added

  socket.emit('id', player.id); // send id

  socketIds.set(player.id, socket.id) // record socket.id

  // listen for input
  // update control state
  socket.on('input', code => {
    const control = code.toLowerCase();
    const active = control === code;
    player.controls[control] = active;
    Sleeping.set(player, false);
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

    popEntity(player);

    socketIds.delete(player.id) // forget socket.id
  });
});

// emit regular updates to clients
// extract and broadcast gamestate
// send dynamic bodies update
setInterval(() => {
  const gamestate = dynamic.bodies.flatMap(b => b.isSleeping ? [] : {
    i: b.id,
    x: Math.round(b.position.x),
    y: Math.round(b.position.y),
    r: Math.round(b.angle * 100) / 100,
  });

  io.volatile.emit('update', gamestate);
}, 1000 / 30);

// infrequently emit leaderboard to all clients
setInterval(() => {
  const players = dynamic.bodies.filter(
    body => body.kind === 'player'
  );

  players.sort((a, b) => b.points - a.points);

  const top = players.slice(0, 3);

  // send each player their custom leaderboard
  for (const [playerId, socketId] of socketIds) {
    const you = players.find(player => player.id === playerId);

    const leaderboard = top.includes(you) || !you ? top : top.concat(you);

    io.to(socketId).emit('leaderboard', leaderboard.map(
      ({ nickname, points }) => ({ nickname, points })
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

function handleUpgrade(player, bag) {
  if (!bag.isAvailable) return;
  player.points += bag.points;
  if (bag.sword > player.sword) player.sword = bag.sword;
  if (bag.shield > player.shield) player.shield = bag.shield;

  // inform player of their upgrade
  io.to(socketIds.get(player.id)).emit('upgrade', player.sword, player.shield, bag.points);

  Composite.remove(loot, bag); // remove loot from world
  io.emit('remove', bag.id); // let everyone know loot was removed
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
    popEntity(player);
    
    io.to(socketIds.get(player.id)).emit('death', attacker.nickname);
    io.to(socketIds.get(attacker.id)).emit('kill', player.nickname);

    // respawn after 3 seconds
    setTimeout(() => {
      Composite.add(dynamic, player, {id: player.id});
      Body.setPosition(player, { x: 0, y: -500 });
      player.health = 100;
      player.points = 1;
      player.sword = player.shield = 0;
      io.emit('add', player.id, 'player', player.position); // let everyone know player was added
    }, 3000);

    return;
  }

  // emit 'injury' with new health
  io.to(socketIds.get(player.id)).emit('injury', player.health);
}

// remove entity from world and emit 'remove'
// add items to world and emit 'add'
function popEntity(entity) {
  Composite.remove(dynamic, entity); // remove entity
  io.emit('remove', entity.id); // let everyone know entity was removed
  
  const { x, y } = entity.position;

  // drop bag
  const bag = Bodies.fromVertices(x, y,
    Vertices.fromPath(paths['bag']), {
      mass: 0.1,
      friction: 0.001,
      isStatic: true,
    }
  );
  bag.kind = 'bag';
  bag.class = 'loot'; // for collision type
  bag.points = entity.points;
  bag.sword = entity.sword;
  bag.shield = entity.shield;
  Composite.add(loot, bag);
  io.emit('add', bag.id, 'bag', bag.position); // let everyone know bag was added
  // make bag unavailable for half second so visible before picked up
  bag.isAvailable = false;
  setTimeout(() => bag.isAvailable = true, 500);
}

http.listen(port, () => console.log(`Listening on port ${port}`));
