// app.js

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mongoose = require('mongoose');
const kafka = require('kafka-node');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const Message = require('./models/message');
// Connect to MongoDB
mongoose.connect('mongodb://localhost/chatapp', { useNewUrlParser: true, useUnifiedTopology: true });
const db = mongoose.connection;

db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
});

// Connect to Kafka
const kafkaClient = new kafka.KafkaClient({ kafkaHost: 'localhost:9092' });
const producer = new kafka.Producer(kafkaClient);
const topicsToCreate = [{ topic: 'my-new-topic', partitions: 1, replicationFactor: 1 }];

producer.on('ready', () => {
  console.log('Kafka producer is ready');
});

producer.on('error', (err) => {
  console.error('Error initializing Kafka producer:', err);
});

// Set up Pug as the view engine
app.set('view engine', 'pug');
app.set('views', './views');

// Serve static files from the public directory
app.use(express.static('public'));

// Define routes
app.get('/', (req, res) => {
  res.render('index');
});

// Handle socket.io connections
const connectedUsers = {};

io.on('connection', (socket) => {
  console.log('A user connected');

  // Ask user for their name
  socket.emit('ask for name');

  // Handle user name submission
  socket.on('submit name', (name) => {
    // Store user information in the connectedUsers object
    connectedUsers[socket.id] = { socket, name };

    // Update the user list for the connected client
    socket.emit('update user list', Object.values(connectedUsers).map(user => ({ id: user.socket.id, name: user.name })));

    // Update the user list for all connected clients
    updateUsersList();

    // Join a private room when a user connects
    socket.on('join private room', (targetUserId) => {
      socket.join(targetUserId);
    });
  });

  // Handle private messaging
  socket.on('private message', async (data) => {
    const { targetUserId, message } = data;
  
    const newMessage = new Message({
      senderId: socket.id,
      receiverId: targetUserId,
      senderName: connectedUsers[socket.id].name,
      message: message,
    });
  
    try {
      // Save the message to the database
      await newMessage.save();
  
      // Publish the message to Kafka
      const payloads = [
        {
          topic: `conversation_${socket.id}_${targetUserId}`,
          messages: JSON.stringify({
            senderId: socket.id,
            senderName: connectedUsers[socket.id].name,
            message,
          }),
        },
      ];
  
      producer.send(payloads, (err, data) => {
        if (err) {
          console.error('Error sending message to Kafka:', err);
        } else {
          console.log('Message sent to Kafka:', data);
        }
      });
    } catch (error) {
      console.error('Error saving message to the database:', error);
    }
  });
  
  // Handle user reconnection
  socket.on('reconnect', async () => {
    console.log('User reconnected');
  
    // Ask user for their name
    socket.emit('ask for name');
  
    // Retrieve messages for the specific user from the database
    const messages = await Message.find({
      $or: [{ senderId: socket.id }, { receiverId: socket.id }],
    }).sort({ timestamp: 1 });
  
    // Emit the retrieved messages to the user
    socket.emit('retrieve messages', messages);
  
    // Handle other events as needed...
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');

    // Remove user ID from connectedUsers object
    delete connectedUsers[socket.id];

    // Update the user list for all connected clients
    updateUsersList();
  });

  // Function to update the user list for all connected clients
  function updateUsersList() {
    const userIds = Object.keys(connectedUsers);
    io.emit('update user list', userIds.map(userId => ({ id: userId, name: connectedUsers[userId].name })));
  }
});

// Kafka consumer to handle incoming messages
const Consumer = kafka.Consumer;
const consumer = new Consumer(
  kafkaClient,
  [{ topic: 'my-new-topic' }], // Regex to subscribe to all topics
  { groupId: 'chatAppGroup' }
);

consumer.on('message', (message) => {
  const data = JSON.parse(message.value);
  const { senderId, senderName, message: receivedMessage } = data;

  // Emit the received message to the corresponding room
  io.to(senderId).emit('private message', { senderId, senderName, message: receivedMessage });
});

consumer.on('error', (err) => {
  if (err.name === 'TopicsNotExistError') {
    console.error('Topics not found, attempting to create them:', err.topics);
    kafkaClient.createTopics(err.topics, (createTopicsErr, createTopicsData) => {
      if (createTopicsErr) {
        console.error('Error creating topics:', createTopicsErr);
      } else {
        console.log('Topics created successfully:', createTopicsData);
      }
    });
  } else {
    console.error('Kafka consumer error:', err);
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
