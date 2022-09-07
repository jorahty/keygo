// ██ setup ██

const paths = {
  "terrain": "597 207 198 34 2 207 852 469 1756 236 1587 1 1311 174 997 101",
  "player": "0 80 20 0 40 80",
  "chest": "0 0 60 0 60 40 0 40",
  "token": "10.259 3.128 20 0.518 29.741 3.128 36.872 10.259 39.482 20 36.872 29.741 29.741 36.872 20 39.482 10.259 36.872 3.128 29.741 0.518 20 3.128 10.259",
  "sword": "0 0 40 0 40 40 0 40",
  "shield": "0 0 40 0 40 40 0 40",
  "worm": "145 32 1 32 21 1 120 5"
};

// module aliases
const Engine = Matter.Engine,
  Render = Matter.Render,
  Runner = Matter.Runner,
  Bodies = Matter.Bodies,
  Composite = Matter.Composite,
  Body = Matter.Body,
  Vertices = Matter.Vertices,
  Common = Matter.Common,
  Vector = Matter.Vector,
  Bounds = Matter.Bounds,
  Events = Matter.Events;

// provide concave decomposition support library
Common.setDecomp(decomp);

// create engine and world
const engine = Engine.create(),
  world = engine.world;

// create renderer
var render = Render.create({
  element: document.body,
  engine: engine,
  options: {
    wireframes: false,
    width: 600,
    height: 600,
    hasBounds: true,
    background: '#678',
  },
});

// center the render viewport (aka camera) about origin
Render.lookAt(render, {
  min: { x: -400, y: -400 },
  max: { x: 400, y: 400 },
});

// run the renderer
Render.run(render);

// add terrain, map, decoration
Composite.add(world,
  Bodies.fromVertices(0, 0,
    Vertices.fromPath(paths['terrain']),
  ),
);

// create leaderboard, status bar, inventory, health

// create leaderboard
const leaderboard = document.createElement('table');
document.body.appendChild(leaderboard);
[1, 2, 3, 4].forEach(() => { // 4 rows
  const row = document.createElement('tr');
  [1, 2].forEach(() => ( // 2 columns
    row.appendChild(document.createElement('td'))
  ));
  leaderboard.appendChild(row);
});

// create status bar
const bar = document.createElement('section');
document.body.appendChild(bar);

// create sword, shield, health, hitpoints
const sword = document.createElement('div');
const shield = document.createElement('div');
const health = document.createElement('div');
const hitpoints = document.createElement('div');
[sword, shield, health, hitpoints].forEach(el => bar.appendChild(el));
sword.textContent = shield.textContent = 0;
document.querySelector(':root').style.setProperty('--health', '100%');
[1, 2].forEach(() => health.appendChild(document.createElement('div')));
hitpoints.textContent = 100;

// connect to server

// const nickname = prompt('Nickname'); // get nickname
const nickname = Date.now().toString(16).slice(8); // temp
console.log(nickname); // temp

const socket = io(); // connect to server
socket.emit('nickname', nickname); // send nickname

let myId;
socket.on('id', id => myId = id); // save id

// ██ listen for events to render ██

socket.on('add', (id, kind) => {
  // add body to world
  // appearance based on kind
  // for now, appearance defined by vertices; later, sprite
  Composite.add(world,
    Bodies.fromVertices(-400 + Math.random() * 800, -300,
      Vertices.fromPath(paths[kind]),
      { id: id } // set given id
    )
  );
});

socket.on('remove', id => {
  // remove body from world
  Composite.remove(world, world.bodies.find(body => body.id === id));
});

// update position and rotation of dynamic bodies
socket.on('update', gamestate => {
  for (const { i, x, y, r } of gamestate) {
    const body = world.bodies.find(body => body.id === i);
    if (!body) continue;
    Body.setPosition(body, { x, y }); // update position
    Body.setAngle(body, r); // update rotation
  }

  moveCamera();
});

// have the "camera" follow the player with myId
function moveCamera() {
  // identify body with myId
  const me = world.bodies.find(body => body.id === myId);
  if (!me) return;

  // compute render.postion i.e. center of viewport
  render.position = {
    x: (render.bounds.min.x + render.bounds.max.x) / 2,
    y: (render.bounds.min.y + render.bounds.max.y) / 2
  };

  // compute vector from render.position to player.position
  const delta = Vector.sub(me.position, render.position);

  // on this update, only translate 10% of the way
  Bounds.translate(render.bounds, Vector.mult(delta, 0.1));
}

// render the leaderboard
socket.on('leaderboard', lb => {
  for (let i = 0; i < 4; i++) { // iterate over all 4 rows
    const row = leaderboard.childNodes[i];
    if (i < lb.length) {
      row.firstChild.textContent = lb[i].tokens;
      row.lastChild.textContent = lb[i].nickname;
    } else {
      row.firstChild.textContent = row.lastChild.textContent = '';
    }
  }
});

// ██ create and configure controls to send input to server ██

const controls = document.createElement('section');
document.body.appendChild(controls);

// define controls
const left = document.createElement('button');
const right = document.createElement('button');
const translate = document.createElement('button');

// define map
const bindings = new Map();
bindings.set('a', left);
bindings.set('d', right);
bindings.set('l', translate);

for (const [code, control] of bindings) {
  controls.appendChild(control);
  control.textContent = code;
  control.onpointerdown = e => input(code, true);
  control.onpointerup = e => input(code, false);
}

function input(code, down) {
  bindings.get(code).className = down ? 'down' : '';
  if (!down) code = code.toUpperCase();
  socket.volatile.emit('input', code);
}

onkeydown = e => {
  if ('adl'.includes(e.key)) input(e.key, true);
};

onkeyup = e => {
  if ('adl'.includes(e.key)) input(e.key, false);
};

// listen for strike
socket.on('strike', (damage, positions) => {
  positions.forEach(({ x, y }) => {
    // create damage indicator
    const damageIndicator = Body.create({
      position: { x, y },
      render: {
        fillStyle: '#ea7',
        zIndex: 10,
        lineWidth: 5,
        strokeStyle: '#000',
        text: {
          content: damage,
          font: 'bold 48px Arial Rounded MT Bold',
        },
      },
    });

    // render damage indicator for 2 seconds
    Composite.add(world, damageIndicator);
    setTimeout(() => Composite.remove(world, damageIndicator), 2000);
  });
});

// listen for injury
socket.on('injury', health => {
  document.querySelector(':root')
    .style.setProperty('--health', `${health}%`);
  hitpoints.textContent = health;
});

// listen for kill
socket.on('kill', nickname => {
  display(`you eliminated ${nickname}`);
});

// listen for death
socket.on('death', nickname => {
  // reset health
  document.querySelector(':root')
    .style.setProperty('--health', `100%`);
  hitpoints.textContent = 100;

  display(`${nickname} eliminated you`);
});

function display(message) {
  console.log(message);
  const p = document.createElement('p');
  document.body.appendChild(p);
  p.textContent = message;
  setTimeout(() => (
    document.body.removeChild(p)
  ), 3000);
}
