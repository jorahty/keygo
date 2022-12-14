// ██ setup ██

const paths = {
  "terrain": "1980 1641 2250 1467 2430 1705 2527 854 2015 775 1663 117 1887 47 2778 918 2657 1885 1533 2122 1 1564 562 539 1481 1 1527 95 307 1285 672 1674 863 1498 1265 1674 1663 1564",
  "player": "0 80 20 0 40 80",
  "chest": "0 0 60 0 60 40 0 40",
  "bag": "0 0 40 0 40 40 0 40",
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
    width: 800,
    height: 850,
    hasBounds: true,
    background: '#525053',
  },
});

// center the render viewport (aka camera) about origin
Render.lookAt(render, {
  min: { x: -360, y: -360 },
  max: { x: 360, y: 360 },
});

// add terrain, map, decoration
Composite.add(world,
  Bodies.fromVertices(0, 0,
    Vertices.fromPath(paths['terrain']), {
      isStatic: true,
      render: {
        fillStyle: '#538aaa',
        strokeStyle: '#000',
        lineWidth: 4,
      },
    }
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

// create controls container
const controls = document.createElement('section');
document.body.appendChild(controls);

// create messages container
const messages = document.createElement('article');
document.body.appendChild(messages);

// connect to server

// const nickname = prompt('Name'); // get nickname
const nickname = Date.now().toString(16).slice(8); // temp
console.log(nickname); // temp

const socket = io(); // connect to server
socket.emit('nickname', nickname); // send nickname

let myId;
socket.on('id', id => myId = id); // save id

// ██ listen for events to render ██

socket.on('add', (id, kind, {x, y}, angle) => {
  // add body to world
  // appearance based on kind
  // for now, appearance defined by vertices; later, sprite
  Composite.add(world,
    Bodies.fromVertices(x, y,
      Vertices.fromPath(paths[kind]), { id, angle: angle ? angle : 0,
        render: {
          strokeStyle: '#000',
          lineWidth: 4,
        },
      }
    )
  );
});

socket.on('remove', id => {
  // remove body from world
  Composite.remove(world, world.bodies.find(body => body.id === id));
});

// update position and rotation of dynamic bodies
socket.on('update', gamestate => {
  console.log(gamestate);
  for (const { i, x, y, r } of gamestate) {
    const body = world.bodies.find(body => body.id === i);
    if (!body) continue;
    Body.setPosition(body, { x, y }); // update position
    Body.setAngle(body, r); // update rotation
  }

  moveCamera();

  Render.world(render);
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

  if (Vector.magnitude(delta) < 1) return; // don't bother

  // on this update, only move camera 10% of the way
  Bounds.translate(render.bounds, Vector.mult(delta, 0.1));
}

// render the leaderboard
socket.on('leaderboard', lb => {
  for (let i = 0; i < 4; i++) { // iterate over all 4 rows
    const row = leaderboard.childNodes[i];
    if (i < lb.length) {
      row.firstChild.textContent = lb[i].points;
      row.lastChild.textContent = lb[i].nickname;
    } else {
      row.firstChild.textContent = row.lastChild.textContent = '';
    }
  }
});

// listen for strike
socket.on('strike', (damage, positions) => {
  positions.forEach(({ x, y }) => {
    // create damage indicator
    const damageIndicator = Body.create({
      position: { x, y },
      render: {
        fillStyle: '#ebbb7d',
        zIndex: 10,
        lineWidth: 5,
        strokeStyle: '#000',
        text: {
          content: damage,
          font: 'bold 48px system-ui',
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

// listen for upgrade
socket.on('upgrade', (sword, shield, points) => {
  display(`${sword} ${shield} ${points}`);
  // if (kind === 'sword') sword.textContent = level;
  // if (kind === 'shield') shield.textContent = level;
});

function display(message) {
  const p = document.createElement('p');
  messages.appendChild(p);
  p.textContent = message;
  setTimeout(() => (
    messages.removeChild(p)
  ), 3000);
}

// ██ create and configure controls to send input to server ██

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
  control.onpointerdown = () => input(code, true);
  control.onpointerup = () => input(code, false);
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
