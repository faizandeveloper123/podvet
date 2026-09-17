const { ipcMain } = require('electron');
const saasClient = require('./saasClient');

// Pet CRUD (scoped to one client) + the clinic-wide "Patients" reads —
// backed by the multi-tenant API's /api/clients/:id/pets and /api/pets.
// See handlers/clientsHandlers.js for Client CRUD, and handlers/
// recordHandlers.js for Records/EMR (SOAP notes, vaccinations, etc.).

// API responses are camelCase; every renderer screen still expects the
// legacy snake_case shape — translated here so Clients.jsx/Patients.jsx
// don't need to change field access patterns just because the data now
// comes from HTTP instead of SQL.
function toLocalPet(pet) {
  return {
    pet_id: pet.id,
    client_id: pet.clientId,
    pet_name: pet.petName,
    sex: pet.sex,
    species: pet.species,
    breed: pet.breed,
    color: pet.color,
    date_of_birth: pet.dateOfBirth ? pet.dateOfBirth.slice(0, 10) : null,
    age: pet.age,
    is_neutered: pet.isNeutered,
    is_microchipped: pet.isMicrochipped,
    deceased: pet.deceased,
    // This pet's id in whatever legacy per-clinic database it was migrated
    // from — read-only, null for any pet created directly in this app.
    legacy_pet_id: pet.legacyPetId,
  };
}

// GET /api/pets rows also carry the owning client's contact info flattened
// on — matches the legacy JOIN-based "Patients" list/detail shape.
function toLocalPetWithOwner(pet) {
  return {
    ...toLocalPet(pet),
    client_name: pet.clientName,
    contact_number: pet.contactNumber,
    address: pet.address,
  };
}

module.exports = function setupPetsHandlers() {
  ipcMain.handle('retrieve-pets-by-client', async (_event, clientId) => {
    try {
      const result = await saasClient.listClientPets(clientId);
      return { data: result.data.map(toLocalPet), success: true };
    } catch (err) {
      console.error('[retrieve-pets-by-client]', err);
      return { data: [], success: false, message: err.message };
    }
  });

  ipcMain.handle('add-pet', async (_event, petData) => {
    try {
      const result = await saasClient.createClientPet(petData.client_id, {
        petName: petData.pet_name,
        sex: petData.sex,
        species: petData.species,
        breed: petData.breed || null,
        color: petData.color || null,
        dateOfBirth: petData.date_of_birth || null,
        age: petData.age || null,
        isNeutered: !!petData.is_neutered,
        isMicrochipped: !!petData.is_microchipped,
        deceased: petData.deceased ?? null,
      });
      return { success: true, message: 'Pet added successfully', petId: result.data.id };
    } catch (err) {
      return { success: false, message: err.message || 'Could not add pet' };
    }
  });

  ipcMain.handle('update-pet', async (_event, petId, petData) => {
    try {
      await saasClient.updatePet(petId, {
        petName: petData.pet_name,
        sex: petData.sex,
        species: petData.species,
        breed: petData.breed || null,
        color: petData.color || null,
        dateOfBirth: petData.date_of_birth || null,
        age: petData.age || null,
        isNeutered: !!petData.is_neutered,
        isMicrochipped: !!petData.is_microchipped,
        deceased: petData.deceased ?? null,
      });
      return { success: true, message: 'Pet updated successfully' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not update pet' };
    }
  });

  ipcMain.handle('delete-pet', async (_event, petId) => {
    try {
      await saasClient.deletePet(petId);
      return { success: true, message: 'Pet deleted successfully' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not delete pet' };
    }
  });

  // ── Clinic-wide "Patients" reads (formerly patientHandlers.js) ──────────

  ipcMain.handle('patients-get-list', async (_event, { page = 1, limit = 10, search = '', species = '' } = {}) => {
    try {
      const result = await saasClient.listPets({ page, pageSize: limit, search, species: species || undefined });
      return {
        success: true,
        data: result.data.map(toLocalPetWithOwner),
        total: result.total,
        totalPages: result.totalPages,
        page: result.page,
      };
    } catch (err) {
      console.error('[patients-get-list]', err);
      return { success: false, message: err.message, data: [], total: 0 };
    }
  });

  ipcMain.handle('patients-get-species', async () => {
    try {
      const result = await saasClient.listPetSpecies();
      return { success: true, data: result.data };
    } catch (err) {
      console.error('[patients-get-species]', err);
      return { success: false, data: [] };
    }
  });

  ipcMain.handle('patients-get-pet', async (_event, petId) => {
    try {
      const result = await saasClient.getPet(petId);
      return { success: true, data: toLocalPetWithOwner(result.data) };
    } catch (err) {
      console.error('[patients-get-pet]', err);
      return { success: false, message: err.message };
    }
  });
};
