const { ipcMain } = require('electron');
const saasClient = require('./saasClient');

// Client roster (and their pets) — backed by the multi-tenant API's
// /api/clients(/with-pet|/pets), clinic-wide (not branch-scoped; a client
// can be seen and served by any branch of the same clinic). See handlers/
// saasClient.js for the HTTP layer, handlers/petsHandlers.js for pet-only
// CRUD and the clinic-wide "Patients" reads, and handlers/
// clientBillingHandlers.js for the still-legacy unpaid-ledger/WhatsApp
// features that stayed on local MySQL (they query Appointments/Billing,
// which haven't migrated yet).

// API responses are camelCase (clientName, contactNumber, petName, ...);
// every renderer screen still expects the legacy snake_case shape
// (client_name, contact_number, pet_name, ...) — translated here so
// Clients.jsx/Patients.jsx/Appointments.jsx don't need to change field
// access patterns just because the data now comes from HTTP instead of SQL.
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
    legacy_pet_id: pet.legacyPetId,
  };
}

function toLocalClient(client) {
  return {
    client_id: client.id,
    client_name: client.clientName,
    contact_number: client.contactNumber,
    address: client.address,
  };
}

module.exports = function setupClientsHandlers() {
  ipcMain.handle('retrieve-clients', async (_event, page = 1, query = '') => {
    try {
      const result = await saasClient.listClients({ page, pageSize: 10, search: query });

      // Legacy shape: clients and their pets as two separate top-level
      // structures ({ data: [...clients], pets: { [clientId]: [...pets] } })
      // rather than pets nested on each client — kept as-is since Clients.jsx
      // reads it that way.
      const pets = {};
      const data = result.data.map((client) => {
        pets[client.id] = client.pets.map(toLocalPet);
        return toLocalClient(client);
      });

      return { data, pets, total: result.total, page: result.page, totalPages: result.totalPages };
    } catch (err) {
      console.error('[retrieve-clients]', err);
      throw err;
    }
  });

  ipcMain.handle('add-client', async (_event, clientData) => {
    try {
      const result = await saasClient.createClient({
        clientName: clientData.client_name,
        contactNumber: clientData.contact_number,
        address: clientData.address || null,
      });
      return { success: true, message: 'Client added successfully', clientId: result.data.id };
    } catch (err) {
      return { success: false, message: err.message || 'Could not add client' };
    }
  });

  ipcMain.handle('update-client', async (_event, clientId, clientData) => {
    try {
      await saasClient.updateClient(clientId, {
        clientName: clientData.client_name,
        contactNumber: clientData.contact_number,
        address: clientData.address || null,
      });
      return { success: true, message: 'Client updated successfully' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not update client' };
    }
  });

  ipcMain.handle('delete-client', async (_event, clientId) => {
    try {
      await saasClient.deleteClient(clientId);
      return { success: true, message: 'Client and associated pets deleted successfully' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not delete client' };
    }
  });

  ipcMain.handle('search-clients', async (_event, query) => {
    try {
      const result = await saasClient.listClients({ page: 1, pageSize: 10, search: query });
      const clients = result.data.map((client) => ({
        ...toLocalClient(client),
        pet_names: client.pets.map((p) => p.petName).join(','),
      }));
      return { success: true, clients };
    } catch (err) {
      console.error('[search-clients]', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-client-pets', async (_event, clientId) => {
    try {
      const result = await saasClient.listClientPets(clientId);
      return { success: true, pets: result.data.map(toLocalPet) };
    } catch (err) {
      console.error('[get-client-pets]', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('create-client-and-pet', async (_event, data) => {
    try {
      const result = await saasClient.createClientWithPet({
        client: {
          clientName: data.client.client_name,
          contactNumber: data.client.contact_number,
          address: data.client.address || null,
        },
        pet: {
          petName: data.pet.pet_name,
          sex: data.pet.sex,
          species: data.pet.species,
          breed: data.pet.breed || null,
          color: data.pet.color || null,
          dateOfBirth: data.pet.date_of_birth || null,
          age: data.pet.age || null,
          isNeutered: !!data.pet.is_neutered,
          isMicrochipped: !!data.pet.is_microchipped,
        },
      });
      return { success: true, client_id: result.data.client.id, pet_id: result.data.pet.id };
    } catch (err) {
      console.error('[create-client-and-pet]', err);
      return { success: false, error: err.message };
    }
  });

  // Only used as a pre-submit UX check today — add-client/update-client
  // already enforce this server-side (409 on a real duplicate). A `contains`
  // search is good enough for this: phone numbers are specific enough that
  // a substring match essentially only ever matches the same number.
  ipcMain.handle('check-duplicate-phone-number', async (_event, phoneNumber, excludeClientId = null) => {
    try {
      const result = await saasClient.listClients({ page: 1, pageSize: 50, search: phoneNumber });
      const isDuplicate = result.data.some(
        (client) => client.contactNumber === phoneNumber && client.id !== excludeClientId,
      );
      return { isDuplicate };
    } catch (err) {
      console.error('[check-duplicate-phone-number]', err);
      return { isDuplicate: false, error: err.message };
    }
  });
};
