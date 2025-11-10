import dotenv from 'dotenv'
import express from 'express'
import wspRoutes from './routes/wspRoutes.js'

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use("/wa", wspRoutes);
app.listen(PORT, () =>{
    console.log(`[SERVER] corriendo en puerto: ${PORT}`)
})