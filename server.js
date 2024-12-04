const express = require('express');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const { OAuth2Client } = require('google-auth-library');
const path = require('path');
const fs = require('fs');

// Inicializar servidor
const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// Google OAuth 2.0 credentials
const CLIENT_ID = API_ID;
const CLIENT_SECRET = API_SECRET;
const REDIRECT_URI = 'https://refined-sunup-439315-f0.uc.r.appspot.com/oauth2callback';
const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Inicia la API de Google Drive
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Ruta para autenticar a Google con OAuth2
app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive'],
    state: req.query.userId || 'default_user',
  });
  res.redirect(authUrl);
});

// Ruta de callback después de la autenticación
app.get('/oauth2callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send('No se proporciono codigo de autorizacion.');
    }

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Guardar tokens en memoria (o en una base de datos si es necesario)
    global.tokens = tokens;

    res.redirect('/?authenticated=true');
  } catch (error) {
    console.error('Error durante OAuth2 callback:', error);
    res.status(500).send('Autenticacion fallo.');
  }
});

// Ruta para obtener la estructura de carpetas y archivos de Google Drive
app.get('/drive', async (req, res) => {
  try {
    if (!global.tokens) {
      return res.status(401).json({ error: 'Usuario no autentificado' });
    }

    oauth2Client.setCredentials(global.tokens);

    const response = await drive.files.list({
      q: "'root' in parents",
      fields: 'files(id, name, mimeType, parents)',
    });

    const files = response.data.files.map(file => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
    }));

    res.json(files);
  } catch (error) {
    console.error('Error leyendo archivo de Drive:', error);
    res.status(500).json({ error: 'Fallo al leer los archivos' });
  }
});

// Ruta para subir archivos a Google Drive
const multer = require('multer');

const os = require('os');
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
      cb(null, os.tmpdir());
  },
  filename: function (req, file, cb) {
      cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

app.post('/upload', upload.single('file'), async (req, res) => {
  const { folderId } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).send('No se selecciono un archivo.');
  }

  if (!global.tokens) {
    return res.status(401).send('Usuario no autentificado');
  }

  oauth2Client.setCredentials(global.tokens);

  try {
    let validFolderId = 'root'; // Default root si folderId no se proporciona

    if (folderId && folderId !== 'root') {
      try {
        const folder = await drive.files.get({ fileId: folderId, fields: 'id' });
        validFolderId = folder.data.id;
      } catch (err) {
        return res.status(400).send('Carpeta invalida.');
      }
    }

    const fileMetadata = {
      name: file.originalname,
      parents: [validFolderId],
    };

    const media = {
      body: fs.createReadStream(file.path),
    };
    const driveFile = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id',
    });

    fs.unlinkSync(file.path); // Delete the temporary file
    res.json({ fileId: driveFile.data.id });
  } catch (err) {
    res.status(500).send('Error subiendo archivo: ' + err.message);
  }
});

// Ruta para crear carpetas
app.post('/create-folder', async (req, res) => {
  const { folderName, parentFolderId } = req.body;

  if (!global.tokens) {
    return res.status(401).send('Usuario no autentificado');
  }

  oauth2Client.setCredentials(global.tokens);

  const folderMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentFolderId], // Añadir el ID de la carpeta padre
  };

  try {
    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id',
    });

    res.json({ folderId: folder.data.id });
  } catch (err) {
    res.status(500).send('Error al crear la carpeta: ' + err.message);
  }
});

// Ruta para descargar archivos
app.get('/download/:fileId', async (req, res) => {
  const { fileId } = req.params;

  if (!global.tokens) {
    return res.status(401).json({ error: 'Usuario no autentificado' });
  }

  oauth2Client.setCredentials(global.tokens);

  try {
    const file = await drive.files.get(
      { fileId, fields: 'id, name' } // Obtenemos el nombre del archivo
    );

    const { name } = file.data; // Extraemos el nombre del archivo desde la respuesta

    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    // Establecemos el encabezado 'Content-Disposition' con el nombre del archivo
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    response.data.pipe(res);
  } catch (error) {
    res.status(500).json({ error: 'Fallo en la descarga del archivo' });
  }
});

// Ruta para listar archivos en una carpeta específica
app.get('/folder/:folderId', async (req, res) => {
  const { folderId } = req.params;

  if (!global.tokens) {
    return res.status(401).json({ error: 'Usuario no autentificado' });
  }

  oauth2Client.setCredentials(global.tokens);

  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents`,
      fields: 'files(id, name, mimeType, parents)',
    });

    const files = response.data.files.map(file => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
    }));

    res.json(files);
  } catch (error) {
    res.status(500).json({ error: 'Fallo al leer los archivos de la carpeta' });
  }
});

// Ruta para cerrar sesión
app.post('/logout', async (req, res) => {
  global.tokens = null;
  res.json({ message: 'Deslogeo exitoso' });
});

// Inicia el servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});